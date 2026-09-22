const http = require('http');
const os = require('os');
const fs = require('fs');

const packageInfo = require('./package.json');

const PORT = Number(process.env.PORT || 3000);
const REFRESH_SECONDS = Number(process.env.REFRESH_SECONDS || 5);

// ============================================================
// HELPERS
// ============================================================

function readFile(path) {
    try {
        return fs.readFileSync(path, 'utf8').trim();
    } catch {
        return null;
    }
}

function fileExists(path) {
    try {
        return fs.existsSync(path);
    } catch {
        return false;
    }
}

function formatBytes(bytes) {
    if (
        bytes === null ||
        bytes === undefined ||
        Number.isNaN(Number(bytes))
    ) {
        return 'Unavailable';
    }

    const value = Number(bytes);

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function formatUptime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds)));

    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;

    return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}


// ============================================================
// RUNTIME DETECTION
// ============================================================

function isKubernetes() {
    return Boolean(
        process.env.KUBERNETES_SERVICE_HOST ||
        process.env.POD_NAME ||
        process.env.POD_NAMESPACE
    );
}

function isContainer() {
    if (fileExists('/.dockerenv')) {
        return true;
    }

    const cgroup = readFile('/proc/1/cgroup') || '';

    return (
        cgroup.includes('docker') ||
        cgroup.includes('containerd') ||
        cgroup.includes('kubepods')
    );
}

function getRuntimeType() {
    if (isKubernetes()) {
        return 'Kubernetes';
    }

    if (process.env.RUNTIME_TYPE) {
        return process.env.RUNTIME_TYPE;
    }

    if (fileExists('/.dockerenv')) {
        return 'Docker';
    }

    if (isContainer()) {
        return 'Container';
    }

    return 'Linux Host';
}


// ============================================================
// NETWORK INFORMATION
// ============================================================

function getNetworkInfo() {
    const interfaces = os.networkInterfaces();

    const ipv4 = [];
    const ipv6 = [];

    for (const [name, addresses] of Object.entries(interfaces)) {
        for (const address of addresses || []) {
            if (address.internal) {
                continue;
            }

            const info = {
                interface: name,
                address: address.address,
                family: address.family,
                mac: address.mac
            };

            if (address.family === 'IPv4') {
                ipv4.push(info);
            } else if (address.family === 'IPv6') {
                ipv6.push(info);
            }
        }
    }

    const preferredIP =
        process.env.POD_IP ||
        process.env.CONTAINER_IP ||
        ipv4[0]?.address ||
        'Unavailable';

    return {
        preferredIP,
        ipv4,
        ipv6
    };
}


// ============================================================
// MEMORY - CGROUP V1 / V2
// ============================================================

function getMemoryInfo() {

    let usage = null;
    let limit = null;
    let version = 'unknown';

    // cgroup v2
    if (fileExists('/sys/fs/cgroup/memory.current')) {

        version = 'v2';

        const usageRaw = readFile('/sys/fs/cgroup/memory.current');
        const limitRaw = readFile('/sys/fs/cgroup/memory.max');

        usage = Number(usageRaw);

        if (limitRaw && limitRaw !== 'max') {
            limit = Number(limitRaw);
        }

    // cgroup v1
    } else if (
        fileExists(
            '/sys/fs/cgroup/memory/memory.usage_in_bytes'
        )
    ) {

        version = 'v1';

        usage = Number(
            readFile(
                '/sys/fs/cgroup/memory/memory.usage_in_bytes'
            )
        );

        const rawLimit = Number(
            readFile(
                '/sys/fs/cgroup/memory/memory.limit_in_bytes'
            )
        );

        // Ignore extremely large values representing "unlimited".
        if (
            Number.isFinite(rawLimit) &&
            rawLimit > 0 &&
            rawLimit < 9e18
        ) {
            limit = rawLimit;
        }
    }

    // If not running with an explicit container memory limit,
    // use total system memory as informational fallback.
    if (!Number.isFinite(usage)) {
        usage = null;
    }

    if (
        Number.isFinite(limit) &&
        limit > os.totalmem() * 100
    ) {
        limit = null;
    }

    const percentage =
        usage !== null &&
        limit !== null &&
        limit > 0
            ? ((usage / limit) * 100).toFixed(2)
            : null;

    return {
        cgroupVersion: version,

        usageBytes: usage,
        usage: usage !== null
            ? formatBytes(usage)
            : 'Unavailable',

        limitBytes: limit,
        limit: limit !== null
            ? formatBytes(limit)
            : 'Unlimited / Not configured',

        percentage: percentage !== null
            ? `${percentage}%`
            : 'N/A'
    };
}


// ============================================================
// CPU - CGROUP V1 / V2
// ============================================================

function readContainerCpuMicroseconds() {

    // cgroup v2
    if (fileExists('/sys/fs/cgroup/cpu.stat')) {

        const stat = readFile('/sys/fs/cgroup/cpu.stat');

        const usageLine = stat
            ?.split('\n')
            .find(line => line.startsWith('usage_usec '));

        if (usageLine) {
            return Number(usageLine.split(/\s+/)[1]);
        }
    }

    // cgroup v1
    if (
        fileExists(
            '/sys/fs/cgroup/cpuacct/cpuacct.usage'
        )
    ) {
        const nanoseconds = Number(
            readFile(
                '/sys/fs/cgroup/cpuacct/cpuacct.usage'
            )
        );

        return nanoseconds / 1000;
    }

    return null;
}

function getCpuLimit() {

    // cgroup v2
    if (fileExists('/sys/fs/cgroup/cpu.max')) {

        const value = readFile('/sys/fs/cgroup/cpu.max');

        if (value) {

            const [quotaRaw, periodRaw] =
                value.split(/\s+/);

            if (
                quotaRaw !== 'max' &&
                Number(quotaRaw) > 0 &&
                Number(periodRaw) > 0
            ) {
                return Number(quotaRaw) /
                    Number(periodRaw);
            }
        }
    }

    // cgroup v1
    const quotaPath =
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';

    const periodPath =
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

    if (
        fileExists(quotaPath) &&
        fileExists(periodPath)
    ) {

        const quota = Number(readFile(quotaPath));
        const period = Number(readFile(periodPath));

        if (quota > 0 && period > 0) {
            return quota / period;
        }
    }

    return null;
}

let previousCpuSample = {
    time: process.hrtime.bigint(),
    usage: readContainerCpuMicroseconds()
};

function getCpuInfo() {

    const currentTime = process.hrtime.bigint();

    const currentUsage =
        readContainerCpuMicroseconds();

    let percentage = null;

    if (
        currentUsage !== null &&
        previousCpuSample.usage !== null
    ) {

        const elapsedMicroseconds =
            Number(
                currentTime -
                previousCpuSample.time
            ) / 1000;

        const cpuUsedMicroseconds =
            currentUsage -
            previousCpuSample.usage;

        if (
            elapsedMicroseconds > 0 &&
            cpuUsedMicroseconds >= 0
        ) {
            percentage =
                (cpuUsedMicroseconds /
                    elapsedMicroseconds) * 100;
        }
    }

    previousCpuSample = {
        time: currentTime,
        usage: currentUsage
    };

    const cpuLimit = getCpuLimit();

    const availableParallelism =
        typeof os.availableParallelism === 'function'
            ? os.availableParallelism()
            : os.cpus().length;

    return {
        usage:
            percentage !== null
                ? `${percentage.toFixed(2)}%`
                : 'Collecting...',

        availableCores: availableParallelism,

        cpuLimit:
            cpuLimit !== null
                ? cpuLimit.toFixed(2)
                : 'Unlimited / Not configured',

        hostVisibleCores: os.cpus().length
    };
}


// ============================================================
// KUBERNETES INFORMATION
// ============================================================

function getKubernetesInfo() {

    if (!isKubernetes()) {
        return null;
    }

    return {
        podName:
            process.env.POD_NAME ||
            os.hostname(),

        namespace:
            process.env.POD_NAMESPACE ||
            readFile(
                '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
            ) ||
            'Unavailable',

        podIP:
            process.env.POD_IP ||
            getNetworkInfo().preferredIP,

        nodeName:
            process.env.NODE_NAME ||
            'Not injected',

        serviceAccount:
            readFile(
                '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
            )
                ? process.env.SERVICE_ACCOUNT ||
                  'Mounted'
                : 'Unavailable',

        kubernetesServiceHost:
            process.env.KUBERNETES_SERVICE_HOST ||
            'Unavailable',

        kubernetesServicePort:
            process.env.KUBERNETES_SERVICE_PORT ||
            'Unavailable'
    };
}


// ============================================================
// APPLICATION INFORMATION
// ============================================================

function getRuntimeInfo() {

    const network = getNetworkInfo();

    const memory = getMemoryInfo();

    const cpu = getCpuInfo();

    const processMemory =
        process.memoryUsage();

    const kubernetes =
        getKubernetesInfo();

    const hostname =
        os.hostname();

    return {

        timestamp:
            new Date().toISOString(),

        application: {
            name:
                packageInfo.name ||
                'Node.js Application',

            version:
                packageInfo.version ||
                'Unknown',

            port: PORT
        },

        runtime: {
            type:
                getRuntimeType(),

            hostname,

            containerName:
                process.env.CONTAINER_NAME ||
                process.env.POD_NAME ||
                hostname,

            containerId:
                hostname,

            containerIP:
                network.preferredIP,

            hostPort:
                process.env.HOST_PORT ||
                'Not exposed to application',

            hostName:
                process.env.DOCKER_HOST_NAME ||
                process.env.NODE_NAME ||
                'Not exposed to application'
        },

        kubernetes,

        node: {
            version:
                process.version,

            platform:
                process.platform,

            architecture:
                process.arch,

            pid:
                process.pid,

            uptime:
                formatUptime(
                    process.uptime()
                )
        },

        cpu,

        memory: {
            ...memory,

            processRSS:
                formatBytes(
                    processMemory.rss
                ),

            processHeapUsed:
                formatBytes(
                    processMemory.heapUsed
                ),

            processHeapTotal:
                formatBytes(
                    processMemory.heapTotal
                )
        },

        network: {
            primaryIP:
                network.preferredIP,

            ipv4:
                network.ipv4
        }
    };
}


// ============================================================
// HTML
// ============================================================

function card(label, id, description) {
    return `
        <div class="card">
            <div class="label">${escapeHtml(label)}</div>
            <div class="value" id="${id}">Loading...</div>
            <div class="description">
                ${escapeHtml(description)}
            </div>
        </div>
    `;
}

function renderPage() {

    return `
<!DOCTYPE html>
<html>
<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
    >

    <title>
        Runtime Environment Dashboard
    </title>

    <style>

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family:
                Arial,
                Helvetica,
                sans-serif;
            background: #f4f7fb;
            color: #182238;
        }

        .header {
            padding: 32px 20px;
            text-align: center;
            background:
                linear-gradient(
                    120deg,
                    #101a35,
                    #284daf
                );
            color: white;
        }

        .status {
            display: inline-block;
            padding: 8px 16px;
            border-radius: 20px;
            background: #176b45;
            font-weight: bold;
            font-size: 13px;
            margin-bottom: 12px;
        }

        .header h1 {
            margin: 4px 0;
        }

        .header p {
            opacity: .85;
        }

        .container {
            width: min(1200px, 94%);
            margin: 26px auto;
        }

        .summary {
            background: white;
            border-radius: 16px;
            padding: 22px;
            margin-bottom: 22px;
            box-shadow:
                0 8px 30px rgba(
                    0,
                    0,
                    0,
                    .07
                );
        }

        .runtime-badge {
            display: inline-block;
            padding: 8px 14px;
            border-radius: 18px;
            background: #eaf1ff;
            color: #1e48a8;
            font-weight: bold;
        }

        .grid {
            display: grid;
            grid-template-columns:
                repeat(
                    auto-fit,
                    minmax(230px, 1fr)
                );
            gap: 16px;
        }

        .card {
            background: white;
            border-radius: 14px;
            padding: 20px;
            min-height: 135px;
            box-shadow:
                0 5px 20px rgba(
                    0,
                    0,
                    0,
                    .06
                );
        }

        .label {
            text-transform: uppercase;
            font-size: 11px;
            letter-spacing: 1px;
            color: #71809b;
            font-weight: bold;
            margin-bottom: 14px;
        }

        .value {
            font-size: 21px;
            font-weight: bold;
            word-break: break-word;
            margin-bottom: 9px;
        }

        .description {
            color: #78859a;
            font-size: 12px;
            line-height: 1.5;
        }

        .section-title {
            margin:
                30px 0 14px 2px;
        }

        .footer {
            text-align: center;
            padding: 30px;
            color: #78859a;
            font-size: 12px;
        }

        .good {
            color: #14844a;
        }

    </style>

</head>

<body>

    <div class="header">

        <div class="status">
            ● APPLICATION RUNNING
        </div>

        <h1>
            Node.js Runtime Environment
        </h1>

        <p>
            Live Docker / Kubernetes runtime information
        </p>

    </div>


    <div class="container">

        <div class="summary">

            Runtime detected:

            <span
                class="runtime-badge"
                id="runtimeType"
            >
                Loading...
            </span>

            <div
                style="
                    margin-top:12px;
                    color:#71809b;
                "
            >
                Last refresh:
                <span id="timestamp">
                    Loading...
                </span>
            </div>

        </div>


        <h2 class="section-title">
            Runtime
        </h2>

        <div class="grid">

            ${card(
                'Runtime Type',
                'runtimeTypeCard',
                'Automatically detected environment'
            )}

            ${card(
                'Container / Pod Name',
                'containerName',
                'Runtime identity'
            )}

            ${card(
                'Hostname / Container ID',
                'containerId',
                'Hostname visible to Node.js'
            )}

            ${card(
                'Container / Pod IP',
                'containerIP',
                'Current primary IPv4 address'
            )}

            ${card(
                'Host Port',
                'hostPort',
                'Published port when supplied by runtime'
            )}

            ${card(
                'Application Port',
                'applicationPort',
                'Port Node.js listens on'
            )}

        </div>


        <h2 class="section-title">
            Node.js
        </h2>

        <div class="grid">

            ${card(
                'Node.js Version',
                'nodeVersion',
                'Actual running Node.js version'
            )}

            ${card(
                'Platform',
                'platform',
                'Operating system platform'
            )}

            ${card(
                'Architecture',
                'architecture',
                'Runtime architecture'
            )}

            ${card(
                'PID',
                'pid',
                'Node.js process ID'
            )}

            ${card(
                'Process Uptime',
                'uptime',
                'Current Node.js process uptime'
            )}

            ${card(
                'Application Version',
                'applicationVersion',
                'Read from package.json'
            )}

        </div>


        <h2 class="section-title">
            CPU
        </h2>

        <div class="grid">

            ${card(
                'CPU Usage',
                'cpuUsage',
                'Current cgroup CPU consumption'
            )}

            ${card(
                'Available CPU Cores',
                'cpuCores',
                'CPU parallelism available to Node.js'
            )}

            ${card(
                'CPU Limit',
                'cpuLimit',
                'Container CPU quota when configured'
            )}

            ${card(
                'Visible Host Cores',
                'hostCores',
                'Processors visible in the namespace'
            )}

        </div>


        <h2 class="section-title">
            Memory
        </h2>

        <div class="grid">

            ${card(
                'Container Memory Usage',
                'memoryUsage',
                'Live cgroup memory consumption'
            )}

            ${card(
                'Container Memory Limit',
                'memoryLimit',
                'Configured cgroup memory limit'
            )}

            ${card(
                'Memory Usage %',
                'memoryPercent',
                'Usage relative to configured limit'
            )}

            ${card(
                'Node.js RSS',
                'processRSS',
                'Resident memory used by Node.js'
            )}

            ${card(
                'Node Heap Used',
                'heapUsed',
                'JavaScript heap currently used'
            )}

            ${card(
                'Node Heap Total',
                'heapTotal',
                'JavaScript heap allocated'
            )}

        </div>


        <div id="kubernetesSection">

            <h2 class="section-title">
                Kubernetes
            </h2>

            <div class="grid">

                ${card(
                    'Pod Name',
                    'podName',
                    'Current Kubernetes Pod'
                )}

                ${card(
                    'Namespace',
                    'namespace',
                    'Kubernetes namespace'
                )}

                ${card(
                    'Pod IP',
                    'podIP',
                    'Current Pod IP'
                )}

                ${card(
                    'Node Name',
                    'nodeName',
                    'Kubernetes worker/control node'
                )}

                ${card(
                    'Kubernetes API Host',
                    'kubernetesHost',
                    'Cluster service endpoint'
                )}

            </div>

        </div>


        <div class="footer">

            Runtime values refresh automatically every
            ${REFRESH_SECONDS} seconds.

        </div>

    </div>


<script>

function setText(id, value) {

    const element =
        document.getElementById(id);

    if (element) {
        element.textContent =
            value ?? 'Unavailable';
    }
}


async function refreshRuntime() {

    try {

        const response =
            await fetch(
                '/api/runtime',
                {
                    cache: 'no-store'
                }
            );

        if (!response.ok) {
            throw new Error(
                'Runtime API returned ' +
                response.status
            );
        }

        const data =
            await response.json();


        setText(
            'runtimeType',
            data.runtime.type
        );

        setText(
            'runtimeTypeCard',
            data.runtime.type
        );

        setText(
            'timestamp',
            new Date(
                data.timestamp
            ).toLocaleString()
        );

        setText(
            'containerName',
            data.runtime.containerName
        );

        setText(
            'containerId',
            data.runtime.containerId
        );

        setText(
            'containerIP',
            data.runtime.containerIP
        );

        setText(
            'hostPort',
            data.runtime.hostPort
        );

        setText(
            'applicationPort',
            data.application.port
        );


        setText(
            'nodeVersion',
            data.node.version
        );

        setText(
            'platform',
            data.node.platform
        );

        setText(
            'architecture',
            data.node.architecture
        );

        setText(
            'pid',
            data.node.pid
        );

        setText(
            'uptime',
            data.node.uptime
        );

        setText(
            'applicationVersion',
            data.application.version
        );


        setText(
            'cpuUsage',
            data.cpu.usage
        );

        setText(
            'cpuCores',
            data.cpu.availableCores
        );

        setText(
            'cpuLimit',
            data.cpu.cpuLimit
        );

        setText(
            'hostCores',
            data.cpu.hostVisibleCores
        );


        setText(
            'memoryUsage',
            data.memory.usage
        );

        setText(
            'memoryLimit',
            data.memory.limit
        );

        setText(
            'memoryPercent',
            data.memory.percentage
        );

        setText(
            'processRSS',
            data.memory.processRSS
        );

        setText(
            'heapUsed',
            data.memory.processHeapUsed
        );

        setText(
            'heapTotal',
            data.memory.processHeapTotal
        );


        const kubernetesSection =
            document.getElementById(
                'kubernetesSection'
            );

        if (data.kubernetes) {

            kubernetesSection.style.display =
                'block';

            setText(
                'podName',
                data.kubernetes.podName
            );

            setText(
                'namespace',
                data.kubernetes.namespace
            );

            setText(
                'podIP',
                data.kubernetes.podIP
            );

            setText(
                'nodeName',
                data.kubernetes.nodeName
            );

            setText(
                'kubernetesHost',
                data.kubernetes
                    .kubernetesServiceHost
            );

        } else {

            kubernetesSection.style.display =
                'none';
        }

    } catch (error) {

        console.error(
            'Runtime refresh failed:',
            error
        );
    }
}


refreshRuntime();

setInterval(
    refreshRuntime,
    ${REFRESH_SECONDS * 1000}
);

</script>

</body>
</html>
    `;
}


// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(
    (req, res) => {

        if (
            req.url === '/health' ||
            req.url === '/healthz'
        ) {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'application/json'
                }
            );

            return res.end(
                JSON.stringify(
                    {
                        status: 'UP',
                        application:
                            packageInfo.name,
                        version:
                            packageInfo.version
                    }
                )
            );
        }


        if (req.url === '/api/runtime') {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'application/json',
                    'Cache-Control':
                        'no-store'
                }
            );

            return res.end(
                JSON.stringify(
                    getRuntimeInfo(),
                    null,
                    2
                )
            );
        }


        if (req.url === '/') {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'text/html; charset=utf-8',
                    'Cache-Control':
                        'no-store'
                }
            );

            return res.end(
                renderPage()
            );
        }


        res.writeHead(
            404,
            {
                'Content-Type':
                    'application/json'
            }
        );

        res.end(
            JSON.stringify(
                {
                    error: 'Not Found'
                }
            )
        );
    }
);


server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '========================================'
        );

        console.log(
            `${packageInfo.name} ${packageInfo.version}`
        );

        console.log(
            `Runtime: ${getRuntimeType()}`
        );

        console.log(
            `Hostname: ${os.hostname()}`
        );

        console.log(
            `IP: ${getNetworkInfo().preferredIP}`
        );

        console.log(
            `Node.js: ${process.version}`
        );

        console.log(
            `Listening: 0.0.0.0:${PORT}`
        );

        console.log(
            '========================================'
        );
    }
);
