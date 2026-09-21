const http = require('http');
const os = require('os');
const fs = require('fs');

const PORT = 3000;

// Get the IP address of this container
function getContainerIP() {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }

    return 'Unknown';
}

// Read container memory usage from cgroup
function getMemoryInfo() {
    try {
        let usage;
        let limit;

        // cgroup v2
        if (fs.existsSync('/sys/fs/cgroup/memory.current')) {
            usage = parseInt(
                fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')
            );

            limit = parseInt(
                fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8')
            );
        }
        // cgroup v1
        else if (fs.existsSync('/sys/fs/cgroup/memory/memory.usage_in_bytes')) {
            usage = parseInt(
                fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8')
            );

            limit = parseInt(
                fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8')
            );
        }

        if (!usage) {
            return {
                usage: 'Unavailable',
                limit: 'Unavailable'
            };
        }

        return {
            usage: `${(usage / 1024 / 1024).toFixed(2)} MB`,
            limit: limit > 0 && limit < Number.MAX_SAFE_INTEGER
                ? `${(limit / 1024 / 1024).toFixed(2)} MB`
                : 'Unlimited'
        };
    } catch (error) {
        return {
            usage: 'Unavailable',
            limit: 'Unavailable'
        };
    }
}

// Calculate CPU usage of this container/process
function getCPUUsage() {
    const cpus = os.cpus();

    let idle = 0;
    let total = 0;

    for (const cpu of cpus) {
        idle += cpu.times.idle;

        total +=
            cpu.times.user +
            cpu.times.nice +
            cpu.times.sys +
            cpu.times.idle +
            cpu.times.irq;
    }

    return {
        idle,
        total
    };
}

let previousCPU = getCPUUsage();

function calculateCPUPercentage() {
    const currentCPU = getCPUUsage();

    const idleDifference = currentCPU.idle - previousCPU.idle;
    const totalDifference = currentCPU.total - previousCPU.total;

    previousCPU = currentCPU;

    if (totalDifference === 0) {
        return '0.00';
    }

    const usage = 100 - ((idleDifference / totalDifference) * 100);

    return usage.toFixed(2);
}

const server = http.createServer((req, res) => {

    const containerIP = getContainerIP();
    const hostname = os.hostname();
    const memory = getMemoryInfo();
    const cpu = calculateCPUPercentage();

    res.writeHead(200, {
        'Content-Type': 'text/html'
    });

    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Node.js Container Information</title>

            <meta http-equiv="refresh" content="5">

            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 40px;
                }

                h1 {
                    margin-bottom: 30px;
                }

                table {
                    border-collapse: collapse;
                    width: 600px;
                }

                th, td {
                    border: 1px solid #ccc;
                    padding: 12px;
                    text-align: left;
                }

                th {
                    background: #f2f2f2;
                }
            </style>
        </head>

        <body>

            <h1>Hello from Node.js Container</h1>

            <table>

                <tr>
                    <th>Information</th>
                    <th>Current Value</th>
                </tr>

                <tr>
                    <td>Container Hostname</td>
                    <td>${hostname}</td>
                </tr>

                <tr>
                    <td>Container IP</td>
                    <td>${containerIP}</td>
                </tr>

                <tr>
                    <td>Container CPU Usage</td>
                    <td>${cpu}%</td>
                </tr>

                <tr>
                    <td>Container Memory Usage</td>
                    <td>${memory.usage}</td>
                </tr>

                <tr>
                    <td>Container Memory Limit</td>
                    <td>${memory.limit}</td>
                </tr>

            </table>

            <p>Page automatically refreshes every 5 seconds.</p>

        </body>
        </html>
    `);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Application running on port ${PORT}`);
    console.log(`Container IP: ${getContainerIP()}`);
    console.log(`Container Hostname: ${os.hostname()}`);
});
