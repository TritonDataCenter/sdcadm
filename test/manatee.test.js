/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

/*
 * Tests for `sdcadm post-setup ha-manatee` and `sdcadm up manatee`
 * together in a single file since the update procedure will be different
 * depending on HA-setup or One Node Write Mode setup.
 */

var util = require('util');
var format = util.format;

var test = require('tape').test;
var uuid = require('node-uuid');

var exec = require('child_process').exec;
var common = require('./common');
var checkHelp = common.checkHelp;
var shared = require('./shared');

var servers = [];
var instances = [];

function getServers(t, cb) {
    var cmd = 'sdc-cnapi /servers?setup=true|json -H -j';
    exec(cmd, function (err, stderr, stdout) {
        t.ifError(err, 'cnapi error');
        t.equal(stdout, '', 'empty stdout');
        var out = JSON.parse(stderr);
        servers = out;
        cb();
    });
}

function getInstances(t, cb) {
    var cmd = 'sdc-sapi /instances?service_uuid=$(sdc-sapi ' +
        '/services?name=manatee|json -Ha uuid)|json -H';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Get instances error');
        t.equal(stderr, '', 'Get instances empty stderr');
        var insts = JSON.parse(stdout);
        t.ok(Array.isArray(insts), 'Manatee array of instances');
        t.ok(insts.length, 'Manatee instances');
        cb(insts);
    });
}

test('setup', function (t) {
    getServers(t, function () {
        getInstances(t, function (insts) {
            instances = insts;
            shared.prepare(t, {external_nics: true});
        });
    });
});


test('post-setup help ha-manatee', function (t) {
    checkHelp(t, 'post-setup ha-manatee',
    'Create 2nd and 3rd manatee instances as the 1st required step for HA.');
});


test('update non-HA', function (t) {
    // Skip of not into ONWM initially
    if (instances.length > 1) {
        t.end();
        return;
    }
    var command = 'sdcadm up manatee -y --force-same-image';
    exec(command, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var findStrings = [
            'avoid setting SAPI back to proto mode',
            'Verifying manatee current version',
            'Checking manatee-adm version',
            'Reprovisioning "primary" manatee',
            'Waiting for manatee instance',
            'Wait for primary PostgreSQL',
            'Ensure ONE NODE WRITE MODE',
            'Updated successfully'
        ];

        findStrings.forEach(function (str) {
            t.ok(stdout.match(str), 'check update string present');
        });
        t.end();
    });

});


test('post-setup bogus servers', function (t) {
    var cmd = format('sdcadm post-setup ha-manatee -s %s -s %s',
        uuid(), uuid());
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'Bogus servers err');
        t.ok(stderr.match('valid Server UUIDs'),
            'Invalid servers stderr');
        t.end();
    });
});

test('post-setup w/o servers', function (t) {
    var cmd = 'sdcadm post-setup ha-manatee';
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'post-setup w/o servers error');
        t.ok(stderr.match('Must specify 2 target servers'),
            'No servers stderr');
        t.end();
    });
});

test('post-setup OK', function (t) {
    // Skip of not into ONWM initially
    if (instances.length > 1) {
        t.end();
        return;
    }
    var server2 = servers[1] ? servers[1].uuid : servers[0].uuid;
    var server3 = servers[2] ? servers[2].uuid : servers[0].uuid;
    var cmd = format('sdcadm post-setup ha-manatee -s %s -s %s -y',
        server2, server3);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');
        var findStrings = [
            'Add instance "manatee1"',
            'Add instance "manatee2"',
            'Creating 2nd manatee',
            'Disabling manatee0 ONE_NODE_WRITE_MODE',
            'Creating "manatee2" instance',
            'Restart SITTER on manatee0',
            'Calling config-agent',
            'manatee-ha finished'
        ];

        findStrings.forEach(function (str) {
            t.ok(stdout.match(str), 'check update string present');
        });

        t.end();
    });
});

test('update HA', function (t) {
    var command = 'sdcadm up manatee -y --force-same-image';
    exec(command, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var findStrings = [
            'Freezing cluster state',
            'Reprovisioning "async" manatee',
            'Waiting for manatee "async"',
            'Reprovisioning "sync" manatee',
            'Waiting for manatee sync',
            'Reprovisioning "primary" manatee',
            'Waiting for manatee shard to reach full HA',
            'Unfreezing cluster state',
            'Updated successfully'
        ];

        findStrings.forEach(function (str) {
            t.ok(stdout.match(str), 'check update HA string present');
        });
        t.end();
    });
});
