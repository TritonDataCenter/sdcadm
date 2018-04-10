/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 */
'use strict';

const fs = require('fs');
const path = require('path');

var assert = require('assert-plus');


// keep a finite number cn_tools backups on the usb key
function removeOldCNToolsTarballs(arg, next) {
    assert.optionalFunc(arg.progress, 'arg.progress');
    assert.func(next, 'next');

    const progress = arg.progress || console.log;
    const backupPath = '/usbkey/extra/joysetup/';
    let tarballs = fs.readdirSync(backupPath).filter(
        function isCNTools(p) {
            return (p.startsWith('cn_tools.') &&
                    p.endsWith('tar.gz') &&
                    p !== 'cn_tools.tar.gz');
        });
    tarballs.sort();
    tarballs.reverse();
    const toDelete = tarballs.slice(4);
    if (toDelete.length) {
        progress('Removing old cn backups: ' + toDelete.join(', '));
        toDelete.forEach(function rmBall(fname) {
            fs.unlinkSync(path.join(backupPath, fname));
        });
    }
    next();
}

// keep only a finite number of agentsshar files
function removeOldAgentsShars(arg, next) {
    assert.optionalFunc(arg.progress, 'arg.progress');
    assert.func(next, 'next');

    const progress = arg.progress || console.log;
    const agentsDir = '/usbkey/extra/agents';
    const latestLinkName = '/usbkey/extra/agents/latest';

    let latest;
    if (fs.existsSync('/usbkey/extra/agents/latest')) {
        latest = path.resolve(agentsDir,
                              fs.readlinkSync(latestLinkName));
    }

    let shars = fs.readdirSync('/usbkey/extra/agents/').filter(
        function isShar(p) {
            return (p.endsWith('.sh') &&
                    // Prefix was changed from agent- to agents- in TOOLS-1958
                    (p.startsWith('agents-') || p.startsWith('agent-')) &&
                    path.resolve(agentsDir, p) !== latest);
        });

    // With the possible exception of the first run, there should only be a
    // handful of old agent shars to consider.  The full agent install already
    // takes minutes.
    const sortedShars = shars.map(function statShar(fname) {
        return {fname: fname,
                mtime: fs.statSync(path.resolve(agentsDir, fname)).mtime};
    }).sort(function cmp(a, b) {
        return a.mtime - b.mtime;
    }).map(function (pair) {
        return pair.fname;
    });
    sortedShars.reverse();
    const toDelete = sortedShars.slice(3);
    if (toDelete.length) {
        progress('Removing old agentshars: ' + toDelete.join(', '));
        toDelete.forEach(function rmShar(fname) {
            fs.unlinkSync(path.join(agentsDir, fname));
        });
    }
    next();
}

module.exports = {
    removeOldCNToolsTarballs: removeOldCNToolsTarballs,
    removeOldAgentsShars: removeOldAgentsShars
};
