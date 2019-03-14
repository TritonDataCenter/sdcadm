/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */


var test = require('tape').test;
var vasync = require('vasync');
var shared = require('./shared');

var exec = require('child_process').exec;
var util = require('util');


var HEADNODE_UUID = '';
var NUM_INSTS = 0;
var CHANNEL = 'dev';

function getNumInsts(cb) {
    shared.getNumInsts('amonredis', cb);
}

function getChannelForLatestLocalImg(cb) {
    var cmd = 'updates-imgadm get ' +
        '`sdc-sapi /services?name=amonredis|json -H [0].params.image_uuid`' +
        ' -C \'*\' | json channels[0]';
    exec(cmd, function execCb(err, stdout, stderr) {
        if (err) {
            cb(err);
            return;
        }
        var latestLocalImgChannel = stdout.trim();
        cb(null, latestLocalImgChannel);
    });
}

function getLatestImgAvail(channel, cb) {
    var cmd = 'updates-imgadm list name=amonredis --latest --json -C ' +
        channel;
    exec(cmd, function execCb(err, stdout, stderr) {
        if (err) {
            cb(err);
            return;
        }

        var latestImgUuid = JSON.parse(stdout.trim())[0].uuid;
        cb(null, latestImgUuid);
    });
}

test('prepare', function (t) {
    shared.prepare(t, {external_nics: true});
});

test('setup', function setupTest(t) {
    var cmd = 'sysinfo | json UUID';

    exec(cmd, function execCb(err, stdout, stderr) {
        t.ifError(err, 'CNAPI error');
        t.equal(stderr, '', 'Empty stderr');
        HEADNODE_UUID = stdout.trim();

        getNumInsts(function (err2, numInsts) {
            t.ifError(err2, 'vmadm list error');
            t.ok(numInsts >= 1, 'at least one amonredis instance exists');
            NUM_INSTS = numInsts;
            getChannelForLatestLocalImg(function channelCb(err3, c) {
                t.ifError(err3);
                CHANNEL = c;
                t.end();
            });
        });
    });
});


test('sdcadm create --help', function sdcadmCreate(t) {
    exec('sdcadm create --help', function execCb(err, stdout, stderr) {
        t.ifError(err, 'Execution error');

        t.notEqual(stdout.indexOf('sdcadm create SERVICE'), -1);
        t.equal(stderr, '', 'Empty stderr');

        t.end();
    });
});


// Mandatory --server arg:
test('sdcadm create amonredis', function sdcadmCreateAmonredis(t) {
    exec('sdcadm create amonredis', function execCb(err, stdout, stderr) {
        t.ok(err, 'Execution error');

        t.notEqual(stderr.indexOf('must specify at least one server'), -1);

        t.end();
    });
});


// Check that --dev-allow-multiple-instances is mandatory to allow multiple
// instances of non-HA services. We should err out without it.
test('sdcadm create amonredis --dry-run --servers=headnode',
function createMultiple(t) {
    var cmd = 'sdcadm create amonredis --dry-run --servers=' + HEADNODE_UUID;

    exec(cmd, function execCb(err, stdout, stderr) {
        t.ok(err, 'Execution error');

        t.notEqual(stderr.indexOf(
            '"--dev-allow-multiple-instances"'), -1);

        t.end();
    });
});


// Test --dry-run:
test('sdcadm create amonredis --dry-run ' +
        '--dev-allow-multiple-instances -y --s', function createAmonredis(t) {
    var cmd = 'sdcadm create amonredis --dry-run ' +
              '--dev-allow-multiple-instances --yes -s ' +
              HEADNODE_UUID;

    exec(cmd, function execCb(err, stdout, stderr) {
        t.ifError(err, 'Execution error');

        t.notEqual(stdout.indexOf('Completed successfully'), -1,
            '"Completed successfully" is in stdout: ' + JSON.stringify(stdout));
        t.equal(stderr, '', 'Empty stderr');

        getNumInsts(function getNumInstCb(err2, numInsts) {
            t.ifError(err2);
            t.equal(numInsts, NUM_INSTS);
            t.end();
        });
    });
});


// Real create test:
test('sdcadm create amonredis --dev-allow-multiple-instances ' +
     '--yes --server', function realCreate(t) {

    vasync.pipeline({
        arg: {},
        funcs: [
            function createAmonRedis(ctx, next) {
                var cmd = 'sdcadm create amonredis ' +
                    '--dev-allow-multiple-instances --yes --server=' +
                    HEADNODE_UUID;
                exec(cmd, function execCb(err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');
                    t.notEqual(stdout.indexOf('Completed successfully'), -1,
                        'Completed successfully');
                    ctx.stdout = stdout;
                    next();
                });
            },
            function countAmonRedisInsts(ctx, next) {
                getNumInsts(function getNumInstCb(err2, numInsts) {
                    t.ifError(err2, 'vmadm list error');

                    t.equal(numInsts, NUM_INSTS + 1, 'Number of instances');
                    ctx.uuid = ctx.stdout.match(/Instance "(.+?)"/)[1];
                    next();
                });
            },
            function deleteAmonRedis(ctx, next) {
                var cmd = util.format('sdc-sapi /instances/%s -X DELETE',
                        ctx.uuid);
                exec(cmd, function execCb(err, stdout, stderr) {
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
test('sdcadm create amonredis --dev-allow-multiple-instances' +
     ' -y -s --image', function createWithLatestImg(t) {
    vasync.pipeline({
        arg: {},
        funcs: [
            function getLatestImg(ctx, next) {
                getLatestImgAvail(CHANNEL,
                    function getImgCb(updatesErr, imageUuid) {
                    t.ifError(updatesErr, 'updates-imgadm list error');
                    ctx.image_uuid = imageUuid;
                    next();
                });
            },
            function createAmonRedis(ctx, next) {
                var cmd = 'sdcadm create amonredis ' +
                          '--dev-allow-multiple-instances --yes -s ' +
                          HEADNODE_UUID + ' --image=' + ctx.image_uuid +
                    ' -C ' + CHANNEL;
                exec(cmd, function execCb(err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');
                    t.notEqual(stdout.indexOf('Completed successfully'), -1);
                    ctx.stdout = stdout;
                    next();
                });
            },
            function countAmonRedisInsts(ctx, next) {
                getNumInsts(function getNumInstCb(err, numInsts) {
                    t.ifError(err, 'vmadm list error');
                    t.equal(numInsts, NUM_INSTS + 1);
                    ctx.uuid = ctx.stdout.match(/Instance "(.+?)"/)[1];
                    next();
                });
            },
            function deleteAmonRedis(ctx, next) {
                var cmd = util.format('sdc-sapi /instances/%s -X DELETE',
                        ctx.uuid);
                exec(cmd, function execCb(err, stdout, stderr) {
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
