/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */


var test = require('tape').test;
var vasync = require('vasync');

var exec = require('child_process').exec;
var util = require('util');


var HEADNODE_UUID = '';
var NUM_INSTS = 0;

function getNumInsts(cb) {
    // JSSTYLED
    exec('vmadm lookup alias=~"^amonredis\d$"', function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }

        var lines = stdout.split('\n');
        cb(null, lines.length);
    });
}


function getLatestImgAvail(cb) {
    var cmd = 'updates-imgadm list name=amonredis --latest --json';
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

        getNumInsts(function (err2, numInsts) {
            t.ifError(err2, 'vmadm list error');
            t.ok(numInsts >= 1, 'at least one amonredis instance exists');
            NUM_INSTS = numInsts;

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
test('sdcadm create amonredis', function (t) {
    exec('sdcadm create amonredis', function (err, stdout, stderr) {
        t.ok(err, 'Execution error');

        t.notEqual(stderr.indexOf('Must specify server uuid'), -1);

        t.end();
    });
});


// Mandatory --skip-ha-check for non HA service:
test('sdcadm create amonredis --dry-run --server', function (t) {
    var cmd = 'sdcadm create amonredis --dry-run --server=' + HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ok(err, 'Execution error');

        t.notEqual(stderr.indexOf('Must provide \'--skip-ha-check\''), -1);

        t.end();
    });
});


// Test --dry-run:
test('sdcadm create amonredis --dry-run --skip-ha-check -y --s', function (t) {
    var cmd = 'sdcadm create amonredis --dry-run --skip-ha-check --yes -s ' +
              HEADNODE_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');

        t.notEqual(stdout.indexOf('Created successfully'), -1);
        t.equal(stderr, '', 'Empty stderr');

        getNumInsts(function (err2, numInsts) {
            t.ifError(err2);
            t.equal(numInsts, NUM_INSTS);
            t.end();
        });
    });
});


// Real create test:
test('sdcadm create amonredis --skip-ha-check --yes --server', function (t) {

    vasync.pipeline({
        arg: {},
        funcs: [
            function createAmonRedis(ctx, next) {
                var cmd = 'sdcadm create amonredis --skip-ha-check ' +
                    '--yes --server=' + HEADNODE_UUID;
                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');
                    console.log(stdout);
                    t.notEqual(stdout.indexOf('Created successfully'), -1);
                    ctx.stdout = stdout;
                    next();
                });
            },
            function countAmonRedisInsts(ctx, next) {
                getNumInsts(function (err2, numInsts) {
                    t.ifError(err2, 'vmadm list error');

                    t.equal(numInsts, NUM_INSTS + 1);
                    // JSSTYLED
                    ctx.uuid = ctx.stdout.match(/Instance "(.+?)"/)[1];
                    next();
                });
            },
            function deleteAmonRedis(ctx, next) {
                var cmd = util.format('sdc-sapi /instances/%s -X DELETE',
                        ctx.uuid);
                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');
                    next();
                });

            }
        ]
    }, function () {
        t.end();
    });

});


// Create test with latest available image:
test('sdcadm create amonredis --skip-ha-check -y -s --image', function (t) {
    vasync.pipeline({
        arg: {},
        funcs: [
            function getLatestImg(ctx, next) {
                getLatestImgAvail(function (updatesErr, imageUuid) {
                    t.ifError(updatesErr, 'updates-imgadm list error');
                    ctx.image_uuid = imageUuid;
                    next();
                });
            },
            function createAmonRedis(ctx, next) {
                var cmd = 'sdcadm create amonredis --skip-ha-check --yes -s ' +
                          HEADNODE_UUID + ' --image=' + ctx.image_uuid;
                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');
                    console.log(stdout);
                    t.notEqual(stdout.indexOf('Created successfully'), -1);
                    ctx.stdout = stdout;
                    next();
                });
            },
            function countAmonRedisInsts(ctx, next) {
                getNumInsts(function (err2, numInsts) {
                    t.ifError(err2, 'vmadm list error');
                    t.equal(numInsts, NUM_INSTS + 1);
                    // JSSTYLED
                    ctx.uuid = ctx.stdout.match(/Instance "(.+?)"/)[1];
                    next();
                });
            },
            function deleteAmonRedis(ctx, next) {
                var cmd = util.format('sdc-sapi /instances/%s -X DELETE',
                        ctx.uuid);
                exec(cmd, function (err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');
                    next();
                });

            }
        ]
    }, function (resErr) {
        t.end();
    });
});
