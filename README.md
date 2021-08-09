# TODO

Player needs to generate his own bullets - It looks too laggy on other screens


Collision detection response

Update player scores for kills


- Server list on HTML page
- Name selection to URL

```
Cannot GET /test
```

Future:
Bomb/bullet fire sounds
Bomb brighter center with glow animation
Cloud background layer should move
Server selection in-game
User login
Chat
User database

https://codesandbox.io/s/css-tricks-msdf-text-fks8w?from-embed=&file=/src/Text.js


# HOW-TO: Local Development

To set up a development environment:

```
npm update
npm run genkey
(accept all defaults)
```

Update server binary and run it locally:

```
npm run debug
npm run client
npm run testserver
```

Navigate to: https://localhost:8443/

To update client side, run these commands and refresh the browser:

```
npm run debug
npm run client
```


# HOW-TO: Server Deployment

To update all of the servers to latest code:

```
./scripts/deploy.sh
```


# Server List

BossBalloon.io

Server list:
```
- sf: 165.232.141.94
- ny: 67.205.173.217
- lon: 188.166.156.97
- jpn: 172.104.122.175
- aus: 192.53.169.160
```

SphereShooter.io
BalloonShooter.io


# HOW-TO: Server Setup

Add ~/.vimrc
Add sf to ~/.ssh/authorized_keys
sudo apt install nginx
Remove default server from /etc/nginx/sites-enabled

Latest nvm/node:
```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh | bash
```
Restart shell here.
```
nvm install node
nvm install-latest-npm
```

Edit /etc/nginx/nginx.conf:

```
http { 
    ## 
    # Basic Settings 
    ## 
    include mime.types; 
    types { 
        application/wasm wasm; 
    }
```


UPDATE THE URLS!!!!😮
/etc/nginx/sites-available/bossballoon
```
server { 
    listen 80; 
    server_name *.bossballoon.io; 
    return 301 https://ny.bossballoon.io$request_uri; 
} 
server { 
    listen 443 ssl http2; 
    server_name *.bossballoon.io; 
    ssl_certificate /etc/nginx/certs/default.crt;
    ssl_certificate_key /etc/nginx/certs/default.key;
    root /var/www/bossballoon.io; 
    index index.html; 
}
```

Make symlink /etc/nginx/sites-enabled

https://www.digitalocean.com/community/tutorials/how-to-secure-nginx-with-let-s-encrypt-on-ubuntu-20-04

```
ufw allow 10000:30000/udp
ufw allow OpenSSH
ufw allow "Nginx Full"
ufw allow 8443/tcp
ufw enable
```


```
mkdir /etc/nginx/certs/
openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/nginx/certs/default.key -out /etc/nginx/certs/default.crt
```

```
sudo systemctl restart nginx
sudo systemctl status nginx

on err:
sudo journalctl -fu nginx
```

Change domain:
```
certbot --nginx -d ny.bossballoon.io
```

Update the site file as below:

```
server { 
    listen 80; 
    server_name *.bossballoon.io; 
    return 301 https://ny.bossballoon.io$request_uri; 
} 
server { 
    listen 443 ssl http2; 
    server_name *.bossballoon.io; 
    ssl_certificate /etc/letsencrypt/live/ny.bossballoon.io/fullchain.pem; # managed by Certbot 
    ssl_certificate_key /etc/letsencrypt/live/ny.bossballoon.io/privkey.pem; # managed by Certbot 
    root /var/www/bossballoon.io; 
    index index.html; 
}
```

Nodejs setup:

```
apt install g++ cmake libssl-dev
npm install -g pm2

cd ~/server
npm install
```

Copy the letsencrypt keys to ~/server/key.pem and ~/server/cert.pem

```
cp /etc/letsencrypt/live/ny.bossballoon.io/fullchain.pem ~/server/cert.pem

cp /etc/letsencrypt/live/ny.bossballoon.io/privkey.pem ~/server/key.pem
```

Run server on boot:

```
pm2 startup
npm run server
pm2 save
pm2 monit
```


# Gamedev Notes

AssemblyScript:

AS WebGL bindings:
https://github.com/battlelinegames/ASWebGLue
The ASWebGLue examples now need the --exportRuntime flag to work

AS web snake game example:
https://github.com/JairusSW/ASMultiSnake/

AS math:
https://github.com/lume/glas/tree/master/src/as/math
newer:
https://github.com/data-ux/as-3d-math/tree/master/src/as/math

Texture load in background example:
https://codepen.io/trusktr/pen/vYgVbVw

Asteroids walkthrough:
https://wasmbook.com/asteroidstutorial.html

AS classes tutorial:
https://wasmbook.com/assemblyscriptclassdeepdive.html

AS stdlib:
https://www.assemblyscript.org/stdlib/map.html#constructor


Snapshot interpolation:
https://github.com/geckosio/snapshot-interpolation#readme

WebRTC UDP nodejs library:
https://github.com/geckosio/geckos.io#readme
"node-datachannel is much lighter and faster compared to wrtc"

node-datachannel package:
https://www.npmjs.com/package/node-datachannel

localtunnel package:
https://www.npmjs.com/package/localtunnel

db package:
https://www.npmjs.com/package/rezidb

serve package:
https://www.npmjs.com/package/serve

as-websocket:
https://www.npmjs.com/package/as-websocket

as-bind:
https://www.npmjs.com/package/as-bind

as-bitray:
https://www.npmjs.com/package/as-bitray

Audio:
Probably just use a normal OGG file for audio.
https://github.com/petersalomonsen/javascriptmusic/tree/master/wasmaudioworklet
https://petersalomonsen.com/webassemblymusic/livecodev2/?gist=a74d2d036b3ecaa01af4e0f6d03ae7c4
https://www.youtube.com/watch?v=C8j_ieOm4vE&list=PLv5wm4YuO4IxRDu1k8fSBVuUlULA8CRa7


## Canvas Rescaling

Reference:
https://stackoverflow.com/questions/33515707/scaling-a-javascript-canvas-game-properly

Screen size stats:
https://www.rapidtables.com/web/dev/screen-resolution-statistics.html

Disable image smoothing:
https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled

canvas.width and canvas.height set the size of the canvas. canvas.style.width and canvas.style.height set the resolution.


## Touch/Mouse Input

https://patrickhlauke.github.io/getting-touchy-presentation/#157
