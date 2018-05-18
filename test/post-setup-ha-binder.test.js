/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

/*
 * Tests for `sdcadm post-setup ha-binder`
 */

var util = require('util');
var format = util.format;

var test = require('tape').test;
var uuid = require('node-uuid');

var exec = require('child_process').exec;
var common = require('./common');
var checkHelp = common.checkHelp;
var shared = require('./shared');

var haveMultipleServers = false;
var servers = [];

function getServers(t, cb) {
    var cmd = 'sdc-cnapi /servers?setup=true|json -H -j';
    exec(cmd, function (err, stderr, stdout) {
        t.ifError(err, 'cnapi error');
        t.equal(stdout, '', 'empty stdout');
        var out = JSON.parse(stderr);
        servers = out;
        if (out.length && out.length > 1) {
            haveMultipleServers = true;
        }
        cb();
    });
}

function getInstances(t, cb) {
    var cmd = 'sdc-sapi /instances?service_uuid=$(sdc-sapi ' +
        '/services?name=binder|json -Ha uuid)|json -H';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Get instances error');
        t.equal(stderr, '', 'Get instances empty stderr');
        var insts = JSON.parse(stdout);
        t.ok(Array.isArray(insts), 'Binder array of instances');
        t.ok(insts.length, 'Binder instances');
        cb(insts);
    });
}

test('setup', function (t) {
    getServers(t, function () {
        getInstances(t, function () {
            shared.prepare(t, {external_nics: true});
        });
    });
});

test('post-setup help ha-binder', function (t) {
    checkHelp(t, 'post-setup ha-binder',
        'Setup the binder service for high availability (HA)');
});

// `post-setup zookeeper` is deprecated
test('sdcadm post-setup zookeeper', function (t) {
    exec('sdcadm post-setup zookeeper', function (err, stdout, stderr) {
        t.ok(err, 'post-setup zookeeper err');
        t.ok(stdout, 'post-setup zookeeper stdout');
        t.ok(stderr.indexOf('deprecated'), 'post-setup zookeeper stderr');
        t.end();
    });
});

// Test backwards compatibility with the old `-s server` way
test('sdcadm post-setup ha-binder', function (t) {
    var cmd = 'sdcadm post-setup ha-binder -s headnode';
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'Backcompat err');
        t.ok(stdout.indexOf('deprecated'),
            'Backcompat stderr');
        t.ok(stderr.indexOf('Invalid number of binder cluster members'),
            'Backcompat stderr');
        t.end();
    });
});

test('post-setup ha-binder bogus servers', function (t) {
    var cmd = format('sdcadm post-setup ha-binder %s %s %s',
        'headnode', uuid(), uuid());
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'Bogus servers err');
        t.ok(stdout, 'Bogus server stdout');
        t.ok(stderr.indexOf('Must provide valid server UUIDs or hostnames'),
            'Bogus servers stderr');
        t.end();
    });
});

test('post-setup ha-binder invalid number of args', function (t) {
    var cmd = 'sdcadm post-setup ha-binder headnode headnode';
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'invalid number of args err');
        t.equal('', stdout, 'invalid number of args stdout');
        t.ok(stderr.indexOf('invalid number of args'),
            'invalid number of args stderr');
        t.end();
    });
});

test('post-setup ha-binder without --dev-allow-repeat-servers', function (t) {
    var cmd = 'sdcadm post-setup ha-binder headnode headnode headnode';
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'W/o --dev-allow-repeat-servers err');
        t.ok(stdout, 'W/o --dev-allow-repeat-servers stdout');
        t.ok(stderr.indexOf('--dev-allow-repeat-servers'),
            'W/o --dev-allow-repeat-servers stderr');
        t.end();
    });
});

test('post-setup ha-binder with --dev-allow-repeat-servers', function (t) {
    var cmd = 'sdcadm post-setup ha-binder ' +
        ' --dev-allow-repeat-servers' +
        ' --yes' +
        ' headnode headnode headnode';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'ha-binder err');
        t.equal(stderr, '', 'Empty stderr');
        t.ok(stdout.indexOf('Extracting zookeeper data into instance'),
            'Extract ZK data');
        t.ok(stdout.indexOf('Waiting for binder instances to join ZK cluster'),
            'ZK cluster');
        t.ok(stdout.indexOf('Creating "binder'), 'Create instances');
        t.ok(stdout.indexOf('Updating admin network resolvers'),
            'Update resolvers');
        getInstances(t, function (insts) {
            t.ok(insts.length === 3, 'Created two instances');
            t.end();
        });
    });
});

test('post-setup ha-binder replace all instances', function (t) {
    if (!haveMultipleServers) {
        t.end();
        return;
    }
    var aCn = servers.filter(function (s) {
        return (s.hostname !== 'headnode');
    })[0].uuid;

    var cmd = 'sdcadm post-setup ha-binder ' +
        ' --dev-allow-repeat-servers' +
        ' --allow-delete' +
        ' --yes' +
        format(' %s %s %s', aCn, aCn, aCn);
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'Replace all instances err');
        t.ok(stdout, 'Replace all instances stdout');
        t.ok(stderr.indexOf('At least one of the existing' +
            'binder instances must remain'),
            'Replace all instances stderr');
        t.end();
    });
});


test('post-setup ha-binder replace some instances', function (t) {
    if (!haveMultipleServers) {
        t.end();
        return;
    }
    var aCn = servers.filter(function (s) {
        return (s.hostname !== 'headnode');
    })[0].uuid;

    var cmd = 'sdcadm post-setup ha-binder ' +
        ' --dev-allow-repeat-servers' +
        ' --allow-delete' +
        ' --yes' +
        format(' headnode headnode %s', aCn);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Replace some instances err');
        t.equal(stderr, '', 'Replace some instances stderr');
        t.ok(stdout.indexOf('Creating "binder'), 'Create instances');
        t.ok(stdout.indexOf('Updating admin network resolvers'),
            'Update resolvers');
        t.ok(stdout.indexOf('Removing'), 'Remove instance');
        getInstances(t, function (insts) {
            t.ok(insts.length === 3, 'Created one instance, removes another');
            t.end();
        });
    });
});

test('post-setup ha-binder remove w/o --allow-delete', function (t) {
    var cmd = 'sdcadm post-setup ha-binder ' +
        ' --yes' +
        ' headnode';
    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'W/o --allow-delete err');
        t.ok(stdout, 'W/o --allow-delete stdout');
        t.ok(stderr.indexOf('--allow-delete'),
            'W/o --dev-allow-repeat-servers stderr');
        t.end();
    });
});


test('post-setup ha-binder remove HA', function (t) {
    var cmd = 'sdcadm post-setup ha-binder ' +
        ' --allow-delete' +
        ' --yes' +
        ' headnode';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'ha-binder err');
        t.equal(stderr, '', 'Empty stderr');
        t.ok(stdout.indexOf('Extracting zookeeper data into instance'),
            'Extract ZK data');
        getInstances(t, function (insts) {
            t.ok(insts.length === 1, 'Destroyed two instances');
            t.end();
        });
    });
});
