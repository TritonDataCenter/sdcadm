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

    const progress = arg.progress || console.log;
    const backupPath = '/usbkey/extra/joysetup/';
    var tarballs = fs.readdirSync(backupPath).filter(
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

module.exports = {
    removeOldCNToolsTarballs: removeOldCNToolsTarballs
};
