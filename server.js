const http = require('http');

const PORT = 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });

    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>First Jenkins Node.js App</title>
        </head>
        <body>
            <h1>Hello from Node.js!</h1>
            <p>Picked up from GIT now</p>
            <p>Picked up from server now</p>
            <p>This application is deployed by Jenkins.</p>
            <p>GODD JOB!! This application is deployed by Jenkins.</p>
            <p>Server: 192.168.0.111</p>
            <p>NEW CHANGE - Jenkins deployment test successful!</p>
        </body>
        </html>
    `);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Application running on port ${PORT}`);
});
