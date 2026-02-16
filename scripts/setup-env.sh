#!/usr/bin/env bash
# flo.monster Hub — Node.js environment loader
# Source this file to set up the Node.js environment for the flo-hub user.
export NVM_DIR="/home/flo-hub/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null 2>&1
