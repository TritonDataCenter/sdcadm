/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var exec = require('child_process').exec;


var DEFAULT_SERVICES = [
    'adminui', 'amon', 'amonredis', 'assets', 'binder', 'ca', 'cnapi', 'dhcpd',
    'fwapi', 'imgapi', 'mahi', 'manatee', 'moray', 'napi', 'papi', 'rabbitmq',
    'redis', 'sapi', 'sdc', 'ufds', 'vmapi', 'workflow'
];


var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj)); // heh
}


function parseJsonOut(output) {
    try {
        return JSON.parse(output);
    } catch (e) {
        return null; // dodgy
    }
}


function parseTextOut(output) {
    return output.split('\n').filter(function (r) {
        return r !== '';
    }).map(function (r) {
        return r.split(/\s+/);
    });
}


function checkHelp(t, subcommand, match) {
    exec('sdcadm help ' + subcommand, function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf(match), -1);
        t.equal(stderr, '');

        t.end();
    });
}


module.exports = {
    DEFAULT_SERVICES: DEFAULT_SERVICES,
    UUID_RE: UUID_RE,
    checkHelp: checkHelp,
    deepCopy: deepCopy,
    parseJsonOut: parseJsonOut,
    parseTextOut: parseTextOut
};