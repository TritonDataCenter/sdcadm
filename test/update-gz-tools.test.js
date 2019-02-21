/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;
var fs = require('fs');
var util = require('util');

var shared = require('./shared');

var CURRENT_GZ_TOOLS_VERSION = null;
var CURRENT_GZ_TOOLS_CHANNEL;
var LATEST_GZ_TOOLS_UUID = null;
var SDCADM_CHANNEL;

/*
 * Note that it's possible to get an empty string here on a clean setup
 */
function getGzToolsVersion(t, cb) {
    fs.readFile('/opt/smartdc/etc/gz-tools.image', {
        encoding: 'utf8'
    }, function (err, data) {
        t.ifError(err, 'Get version error');
        t.ok(data, 'Empty gz-tools version file');
        cb(data.trim());
    });
}

function getGzToolsChannel(t, cb) {
    if (CURRENT_GZ_TOOLS_VERSION === '') {
        cb();
        return;
    }
    var command = 'updates-imgadm get ' + CURRENT_GZ_TOOLS_VERSION +
        ' -C \'*\' | json channels[0]';
    exec(command, function (err, stdout, stderr) {
        t.ifError(err, 'getGzToolsChannel error');
        // It is possible that we have a gz-tools version already removed
        // from updates-imgadm:
        if (stderr && stderr.match('ResourceNotFound')) {
            cb('');
            return;
        } else {
            t.equal(stderr, '', 'getGzToolsChannel stderr');
            t.ok(stdout, 'getGzToolsChannel stdout');
            cb(stdout.trim());
        }
    });
}

function getSdcAdmChannel(t, cb) {
    exec('sdcadm channel get', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        if (stdout) {
            SDCADM_CHANNEL = stdout.trim();
        }
        cb(SDCADM_CHANNEL);
    });
}

test('prepare', function (t) {
    shared.prepare(t, {external_nics: true});
});

test('setup', function (t) {
    getGzToolsVersion(t, function versionCb(data) {
        CURRENT_GZ_TOOLS_VERSION = data;
        getGzToolsChannel(t, function channelCb(channel) {
            CURRENT_GZ_TOOLS_CHANNEL = channel;
            getSdcAdmChannel(t, function sdcadmChCb() {
                var updatesCmd = '/opt/smartdc/bin/updates-imgadm list ' +
                    'name=gz-tools --latest -o uuid -H';
                if (CURRENT_GZ_TOOLS_CHANNEL) {
                    updatesCmd += ' -C ' + CURRENT_GZ_TOOLS_CHANNEL;
                } else {
                    updatesCmd += ' -C ' + SDCADM_CHANNEL;
                }
                exec(updatesCmd, function (err2, stdout, stderr) {
                    t.ifError(err2,
                        'Error listing gz-tools from updates-imgadm');
                    LATEST_GZ_TOOLS_UUID = stdout.trim();
                    t.ok(LATEST_GZ_TOOLS_UUID, 'Latest gz-tools uuid');
                    t.equal(stderr, '', 'empty stderr');
                    t.end();
                });
            });
        });
    });
});


test('update-gz-tools --latest --just-download', function (t) {
    var cmd = 'sdcadm experimental update-gz-tools --latest ' +
        '--just-download --force-reinstall';
    if (CURRENT_GZ_TOOLS_CHANNEL) {
        cmd += ' -C ' + CURRENT_GZ_TOOLS_CHANNEL;
    }

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Update gz-tools error');
        var findStrings = [
            'Downloading gz-tools',
            'Using channel',
            'Updated gz-tools successfully'
        ];

        findStrings.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1,
                util.format('check just-download string present \'%s\'', str));
        });

        var findNotStrings = [
            'Decompressing gz-tools tarball',
            'Validating gz-tools tarball files',
            'Updating global zone scripts',
            'Finding servers to update'
        ];

        findNotStrings.forEach(function (str) {
            t.equal(stdout.indexOf(str), -1,
                util.format('check just-download string not present %s', str));
        });
        t.equal(stderr, '', 'Update gz.tools stderr');
        getGzToolsVersion(t, function (data) {
            t.equal(CURRENT_GZ_TOOLS_VERSION, data,
                'Expected gz-tools version');
            t.end();
        });
    });
});

test('keep --latest image', function (t) {
    // We need to backup the image we've just downloaded for the final tests,
    // given the following test will remove the file right after the install
    var cmd = util.format('/usr/bin/cp /var/tmp/gz-tools-%s.tgz ' +
        '/var/tmp/backup-gz-tools-%s.tgz',
        LATEST_GZ_TOOLS_UUID, LATEST_GZ_TOOLS_UUID);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Copy gz-tools file error');
        console.log(stdout);
        t.equal(stderr, '', 'Copy gz-tools file');
        t.end();
    });
});

test('update-gz-tools --latest --concurrency=3', function (t) {
    var cmd = 'sdcadm experimental update-gz-tools --latest ' +
        '--force-reinstall --concurrency=3';
    if (CURRENT_GZ_TOOLS_CHANNEL) {
        cmd += ' -C ' + CURRENT_GZ_TOOLS_CHANNEL;
    }
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Update gz-tools error');
        var findStrings = [
            'Using channel',
            'Updated gz-tools successfully',
            'Decompressing gz-tools tarball',
            'Validating gz-tools tarball files',
            'Updating global zone scripts',
            'Finding servers to update'
        ];
        findStrings.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1,
                util.format('check just-download string present %s', str));
        });
        // Already downloaded from previous '--just-download' invocation:
        t.equal(stdout.indexOf('Downloading gz-tools'), -1,
            'update gz-tools not present');
        t.equal(stderr, '', 'Update gz.tools stderr');
        getGzToolsVersion(t, function (data) {
            t.equal(LATEST_GZ_TOOLS_UUID, data,
                'Expected gz-tools version');
            t.end();
        });
    });
});

test('update-gz-tools --latest w/o --force-reinstall', function (t) {
    var cmd = 'sdcadm experimental update-gz-tools --latest';
    if (CURRENT_GZ_TOOLS_CHANNEL) {
        cmd += ' -C ' + CURRENT_GZ_TOOLS_CHANNEL;
    }
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Update gz-tools error');
        var findStrings = [
            'Using channel',
            'already installed',
            'Please re-run with'
        ];
        findStrings.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1,
                util.format('check just-download string present %s', str));
        });
        t.equal(stderr, '', 'Update gz.tools stderr');
        t.end();
    });
});

test('update-gz-tools /path/to/installer', function (t) {
    var cmd = util.format('sdcadm experimental update-gz-tools ' +
        '/var/tmp/backup-gz-tools-%s.tgz ' +
        '--force-reinstall', LATEST_GZ_TOOLS_UUID);
    if (CURRENT_GZ_TOOLS_CHANNEL) {
        cmd += ' -C ' + CURRENT_GZ_TOOLS_CHANNEL;
    }
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Update gz-tools error');
        var findStrings = [
            'Using gz-tools tarball file',
            'Validating gz-tools tarball files',
            'Decompressing gz-tools tarball'
        ];
        findStrings.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1,
                util.format('check just-download string present %s', str));
        });
        t.equal(stderr, '', 'Update gz.tools stderr');
        t.end();
    });
});


// The final test case must consist on leaving the system running exactly
// the same gz-tools version it was before we began running these tests:
test('update-gz-tools IMAGE-UUID', function (t) {
    if (CURRENT_GZ_TOOLS_VERSION === LATEST_GZ_TOOLS_UUID) {
        t.end();
        return;
    }
    if (CURRENT_GZ_TOOLS_VERSION === '' || CURRENT_GZ_TOOLS_CHANNEL === '') {
        t.end();
        return;
    }
    var cmd = 'sdcadm experimental update-gz-tools ' +
        '--force-reinstall ' +
        CURRENT_GZ_TOOLS_VERSION + ' -C ' +
        CURRENT_GZ_TOOLS_CHANNEL;
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Update gz-tools error');
        console.log(stdout);
        t.equal(stderr, '', 'Update gz.tools stderr');
        getGzToolsVersion(t, function (data) {
            t.equal(CURRENT_GZ_TOOLS_VERSION, data,
                'Expected gz-tools version');
            t.end();
        });
    });
});

test('remove --latest image backup', function (t) {
    var cmd = util.format('/usr/bin/rm ' +
        '/var/tmp/backup-gz-tools-%s.tgz',
        LATEST_GZ_TOOLS_UUID);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Update gz-tools error');
        t.equal(stdout, '', 'Update gz.tools stdout');
        t.equal(stderr, '', 'Update gz.tools stderr');
        t.end();
    });
});
