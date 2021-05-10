#!/bin/bash
ServerList=("ny" "sf" "lon" "jpn" "aus")

npm run release
npm run client

for server in ${ServerList[*]}; do
    echo "Working on $server..."

    echo "Deleting old www"
    ssh $server rm -rf /var/www/bossballoon.io/ && mkdir /var/www/bossballoon.io

    echo "Copying new www"
    rsync -avP --files-from=www_file_list.txt client/deploy/ $server:/var/www/bossballoon.io/

    echo "Deleting old server"
    ssh $server pkill node && rm -rf server && mkdir server

    echo "Copying new server"
    rsync -avP --files-from=server_file_list.txt .. $server:~/server/

    echo "Installing server"
    ssh $server cd ~/bossballoon && npm run ubuntu && npm run server
done

