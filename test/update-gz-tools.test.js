/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;
var fs = require('fs');
var util = require('util');
var assert = require('assert-plus');

var CURRENT_GZ_TOOLS_VERSION = null;
var LATEST_GZ_TOOLS_UUID = null;

test('setup', function (t) {
    fs.readFile('/opt/smartdc/etc/gz-tools.image', {
        encoding: 'utf8'
    }, function (err, data) {
        t.ifError(err);
        t.ok(data);
        CURRENT_GZ_TOOLS_VERSION = data;
        var updatesCmd = '/opt/smartdc/bin/updates-imgadm list name=gz-tools ' +
            '--latest -o uuid -H';
        exec(updatesCmd, function (err2, stdout, stderr) {
            t.ifError(err2);
            LATEST_GZ_TOOLS_UUID = stdout.trim();
            t.ok(LATEST_GZ_TOOLS_UUID);
            t.equal(stderr, '');
            t.end();
        });
    });
});

test('update-gz-tools --latest --just-download', function (t) {
    var cmd = 'sdcadm experimental update-gz-tools --latest ' +
        '--just-download --force-reinstall';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        console.log(stdout);
        t.equal(stderr, '');
        t.end();
    });
});

test('keep --latest image', function (t) {
    // We need to backup the image we've just downloaded for the final tests,
    // given the following test will remove the file right after the install
    var cmd = util.format('/usr/bin/cp /var/tmp/gz-tools-%s.tgz ' +
        '/var/tmp/backup-gz-tools-%s.tgz',
        LATEST_GZ_TOOLS_UUID, LATEST_GZ_TOOLS_UUID);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        console.log(stdout);
        t.equal(stderr, '');
        t.end();
    });
});

test('update-gz-tools --latest --concurrency=3', function (t) {
    var cmd = 'sdcadm experimental update-gz-tools --latest ' +
        '--force-reinstall --concurrency=3';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        console.log(stdout);
        t.equal(stderr, '');
        t.end();
    });
});

test('update-gz-tools --latest w/o --force-reinstall', function (t) {
    var cmd = 'sdcadm experimental update-gz-tools --latest';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        console.log(stdout);
        t.equal(stderr, '');
        t.end();
    });
});

// The final test case must consist on leaving the system running exactly
// the same gz-tools version it was before we began running these tests:
test('update-gz-tools IMAGE-UUID', function (t) {
    var cmd = 'sdcadm experimental update-gz-tools ' +
        '--force-reinstall ' +
        CURRENT_GZ_TOOLS_VERSION;
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        console.log(stdout);
        t.equal(stderr, '');
        t.end();
    });
});

test('remove --latest image backup', function (t) {
    var cmd = util.format('/usr/bin/rm ' +
        '/var/tmp/backup-gz-tools-%s.tgz',
        LATEST_GZ_TOOLS_UUID);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        console.log(stdout);
        t.equal(stderr, '');
        t.end();
    });
});
