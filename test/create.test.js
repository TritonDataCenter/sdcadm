/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;


var HEADNODE_UUID = '';
var NEW_NAPI_UUID = '';
var NUM_NAPI = 0;


function getNumNapi(cb) {
    // space before napi is intentional
    exec('vmadm list | grep " napi"', function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }

        var lines = stdout.split('\n');
        return cb(null, lines.length);
    });
}


test('setup', function (t) {
    var cmd = 'sdc-cnapi /servers?alias=headnode | json -H';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        HEADNODE_UUID = JSON.parse(stdout)[0].uuid;

        getNumNapi(function (err2, numNapi) {
            t.ifError(err2);
            t.ok(numNapi >= 1, 'at least one napi instance exists');
            NUM_NAPI = numNapi;

            t.end();
        });
    });
});


test('sdcadm create --help', function (t) {
    exec('sdcadm create --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('sdcadm create <svc>'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm create napi', function (t) {
    exec('sdcadm create napi', function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.notEqual(stderr.indexOf('Must specify server uuid'), -1);

        t.end();
    });
});


test('sdcadm create napi --dry-run --server', function (t) {
    var cmd = 'sdcadm create napi --dry-run --server=' + HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.notEqual(stderr.indexOf('Must provide \'--skip-ha-check\''), -1);

        t.end();
    });
});


test('sdcadm create napi --dry-run --skip-ha-check -y --server', function (t) {
    var cmd = 'sdcadm create napi --dry-run --skip-ha-check --yes --server=' +
              HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('Created successfully'), -1);
        t.equal(stderr, '');

        getNumNapi(function (err2, numNapi) {
            t.ifError(err2);
            t.equal(numNapi, NUM_NAPI);
            t.end();
        });
    });
});


test('sdcadm create napi --skip-ha-check --yes --server', function (t) {
    var cmd = 'sdcadm create napi --skip-ha-check --yes --server=' +
              HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.notEqual(stdout.indexOf('Created successfully'), -1);

        getNumNapi(function (err2, numNapi) {
            t.ifError(err2);

            t.equal(numNapi, NUM_NAPI + 1);
            // JSSTYLED
            NEW_NAPI_UUID = stdout.match(/Instance "(.+?)"/)[1];

            t.end();
        });
    });
});


// TODO: --image


test('teardown', function (t) {
    exec('vmadm destroy ' + NEW_NAPI_UUID, function (err, stdout, stderr) {
        t.ifError(err);

        t.equal(stdout, '');
        t.notEqual(stderr.indexOf('Successfully deleted VM'), -1);

        t.end();
    });
});