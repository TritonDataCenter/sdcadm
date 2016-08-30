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
var util = require('util');


var HEADNODE_UUID = '';
var NAPI_UUID = '';
var NAPI_UUID_2 = '';
var NUM_NAPI = 0;


function getNumNapi(cb) {
    // space before napi is intentional
    exec('vmadm list | grep " napi"', function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }

        var lines = stdout.split('\n');
        cb(null, lines.length);
    });
}


function getLatestImgAvail(cb) {
    var cmd = 'updates-imgadm list name=napi --latest --json';
    exec(cmd, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }

        var latestImgUuid = JSON.parse(stdout.trim())[0].uuid;
        cb(null, latestImgUuid);
    });
}

test('setup', function (t) {
    var cmd = 'sysinfo | json UUID';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'CNAPI error');
        t.equal(stderr, '', 'Empty stderr');
        HEADNODE_UUID = stdout.trim();

        getNumNapi(function (err2, numNapi) {
            t.ifError(err2, 'vmadm list error');
            t.ok(numNapi >= 1, 'at least one napi instance exists');
            NUM_NAPI = numNapi;

            t.end();
        });
    });
});


test('sdcadm create --help', function (t) {
    exec('sdcadm create --help', function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');

        t.notEqual(stdout.indexOf('sdcadm create <svc>'), -1);
        t.equal(stderr, '', 'Empty stderr');

        t.end();
    });
});


// Mandatory --server arg:
test('sdcadm create napi', function (t) {
    exec('sdcadm create napi', function (err, stdout, stderr) {
        t.ok(err, 'Execution error');

        t.notEqual(stderr.indexOf('Must specify server uuid'), -1);

        t.end();
    });
});


// Mandatory --skip-ha-check for non HA service:
test('sdcadm create napi --dry-run --server', function (t) {
    var cmd = 'sdcadm create napi --dry-run --server=' + HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'Execution error');

        t.notEqual(stderr.indexOf('Must provide \'--skip-ha-check\''), -1);

        t.end();
    });
});


// Test --dry-run:
test('sdcadm create napi --dry-run --skip-ha-check -y --server', function (t) {
    var cmd = 'sdcadm create napi --dry-run --skip-ha-check --yes --server=' +
              HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');

        t.notEqual(stdout.indexOf('Created successfully'), -1);
        t.equal(stderr, '', 'Empty stderr');

        getNumNapi(function (err2, numNapi) {
            t.ifError(err2);
            t.equal(numNapi, NUM_NAPI);
            t.end();
        });
    });
});


// Real create test:
test('sdcadm create napi --skip-ha-check --yes --server', function (t) {
    var cmd = 'sdcadm create napi --skip-ha-check --yes --server=' +
              HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        t.notEqual(stdout.indexOf('Created successfully'), -1);

        getNumNapi(function (err2, numNapi) {
            t.ifError(err2, 'vmadm list error');

            t.equal(numNapi, NUM_NAPI + 1);
            // JSSTYLED
            NAPI_UUID = stdout.match(/Instance "(.+?)"/)[1];

            t.end();
        });
    });
});


// Create test with latest available image:
test('sdcadm create napi --skip-ha-check -y -s --image', function (t) {
    getLatestImgAvail(function (updatesErr, latestImageUuid) {
        t.ifError(updatesErr, 'updates-imgadm list error');

        var cmd = 'sdcadm create napi --skip-ha-check --yes --server=' +
                  HEADNODE_UUID + ' --image=' + latestImageUuid;
        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err, 'Execution error');
            t.equal(stderr, '', 'Empty stderr');

            t.notEqual(stdout.indexOf('Created successfully'), -1);

            getNumNapi(function (err2, numNapi) {
                t.ifError(err2, 'vmadm list error');

                t.equal(numNapi, NUM_NAPI + 2);

                // JSSTYLED
                NAPI_UUID_2 = stdout.match(/Instance "(.+?)"/)[1];

                t.end();
            });
        });
    });
});

test('teardown', function (t) {
    var cmd = 'sdc-sapi /instances/%s -X DELETE';

    exec(util.format(cmd, NAPI_UUID), function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        exec(util.format(cmd, NAPI_UUID_2), function (err2, stdout2, stderr2) {
            t.ifError(err2, 'Execution error');
            t.equal(stderr2, '', 'Empty stderr');

            t.end();
        });
    });
});
