#!/bin/bash
ServerList=("ny" "sf" "lon" "jpn" "aus")

npm run release
npm run client

for server in ${ServerList[*]}; do
    echo "Working on $server..."

    echo "Deleting old www"
    ssh $server rm -rf /var/www/bossballoon.io/
    ssh $server mkdir /var/www/bossballoon.io

    echo "Copying new www"
    rsync -avP --files-from=scripts/www_file_list.txt client/deploy/ $server:/var/www/bossballoon.io/

    echo "Copying new server"
    rsync -avP --files-from=scripts/server_file_list.txt . $server:~/server/
done

