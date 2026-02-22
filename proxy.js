const http = require('http');
http.createServer((req, res) => {
  console.log('--- REQUEST ---');
  console.log(req.method, req.url);
  console.log('--- HEADERS ---');
  console.log(req.headers);
  console.log('---------------');
  res.writeHead(401);
  res.end('{}');
}).listen(8080);
