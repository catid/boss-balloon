#!/bin/bash
ServerList=("ny" "sf" "lon" "jpn" "aus")

for server in ${ServerList[*]}; do
    echo "Working on $server..."

    ssh -t $server 'bash -i -c "pm2 restart all"'
done
