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
var bunyan = require('bunyan');
var vasync = require('vasync');
var zkstream = require('zkstream');

var exec = require('child_process').exec;
var common = require('./common');
var checkHelp = common.checkHelp;
var shared = require('./shared');

var servers = [];
var instances = [];
// Used to restore pre-HA manatee setup when possible:
var zkHost;
var zkInitialStateRaw;

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

test('get initial zk-state', function (t) {
    if (instances.length > 1) {
        t.end();
        return;
    }

    var context = {};
    vasync.pipeline({
        arg: context,
        funcs: [
            function getBinderIPs(_, next) {
                var command = 'sdcadm insts binder -j';
                exec(command, function binderIpsCb(err, stdout, stderr) {
                    if (err) {
                        next(err);
                        return;
                    }
                    var out = JSON.parse(stdout.trim());
                    zkHost = out[0].ip;
                    next();
                });
            },
            function createZkClient(ctx, next) {
                var zkc = new zkstream.Client({
                    address: zkHost,
                    port: 2181,
                    log: bunyan.createLogger({
                        name: 'manatee.test',
                        stream: process.stderr,
                        level: 'debug'
                    }),
                    sessionTimeout: 30000
                });
                zkc.once('connect', next);
                zkc.once('failed', function () {
                    zkc.close(function () {
                        next(new Error('Zookeeper connection failed'));
                    });
                });
                zkc.once('close', function () {
                    t.end();
                });

                ctx.zkc = zkc;
            },
            function getSdcZkData(ctx, next) {
                if (!ctx.zkc.isConnected()) {
                    next(new Error('Not connected to Zookeeper'));
                    return;
                }

                ctx.zkc.get('/manatee/sdc/state', function (err, data) {
                    if (err) {
                        next(err);
                        return;
                    }
                    zkInitialStateRaw = data;
                    next();
                });
            }
        ]
    }, function pipeCb(pipeErr) {
        t.ok(context.zkc);
        t.ifError(pipeErr);
        context.zkc.close();
    });
});


test('post-setup help ha-manatee', function (t) {
    checkHelp(t, 'post-setup ha-manatee',
    'Create 2nd and 3rd manatee instances as the 1st required step for HA.');
});


test('update non-HA', function (t) {
    // Skip if not into ONWM initially
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

test('teardown', function (t) {
    if (instances.length > 1) {
        t.end();
        return;
    }

    var context = {};
    var instance = instances[0];
    var alias = instance.params.alias;

    /*
     * Pipeline of functions to be executed only if our setup has moved from
     * ONWM to HA
     */
    var haFuncs = [
        /*
         * set `ctx.instsToRemove`
         */
        function getManateeInstances(ctx, next) {
            getInstances(t, function getInstsCb(insts) {
                // We don't wanna remove first one:
                ctx.instsToRemove = insts.filter(function (inst) {
                    return (inst.params.alias !== alias);
                });
                next();
            });
        },

        /*
         * Call `manatee-adm freeze` before going for the downgrade steps
         */
        function freezeManatee(ctx, next) {
            if (ctx.zkState.freeze) {
                next();
                return;
            }
            var cmd = '/usr/sbin/zlogin ' + instance.uuid +
                ' "source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm freeze ' +
                '-r \'downgrading\'"';
            exec(cmd, next);
        },

        /*
         * Updates initial manatee instance metadata in SAPI
         */
        function setSapiONWM(_, next) {
            var command = util.format(
                '/opt/smartdc/bin/sdc-sapi /instances/%s ' +
                '-d \'{"metadata": {"ONE_NODE_WRITE_MODE": true}}\' -X PUT',
                instance.uuid
            );
            exec(command, next);
        },

        /*
         * Disable manatee-sitter service for all the manatee VMs to remove
         * so we get them out of the manatee-shard as soon as possible
         */
        function disableManateeSitterSvcs(ctx, next) {
            vasync.forEachPipeline({
                inputs: ctx.instsToRemove,
                func: function stopSvc(inst, nextInst) {
                    var cmd = '/usr/sbin/zlogin ' + inst.uuid +
                        ' "svcadm disable manatee-sitter"';
                    exec(cmd, nextInst);
                }
            }, next);
        },

        /*
         * Disables moray services into local moray instance.
         * (It obviously has the drawback of assuming a single local
         * moray instance and no more instances anywyere else)
         */
        function disableMoray(_, next) {
            var cmd = '/usr/sbin/svcadm -z ' +
                '`/opt/smartdc/bin/sdc-vmname moray` disable \'*moray*\'';
            exec(cmd, next);
        },

        function setInstONWM(_, next) {
            var cmd = '/usr/sbin/zlogin ' + instance.uuid +
                ' "source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm ' +
                'set-onwm -m on -y"';
            exec(cmd, next);
        },

        function getSdcZkVersion(ctx, next) {
            if (!ctx.zkc.isConnected()) {
                next(new Error('Not connected to Zookeeper'));
                return;
            }

            ctx.zkc.stat('/manatee/sdc/state', function (err, stat) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.zkVersion = stat.version;
                next();
            });
        },

        function setZkState(ctx, next) {
            if (!ctx.zkc.isConnected()) {
                next(new Error('Not connected to Zookeeper'));
                return;
            }

            ctx.zkc.set(
                '/manatee/sdc/state', zkInitialStateRaw, ctx.zkVersion, next);
        },

        function callManateeConfigAgentSync(_, next) {
            var cmd = '/usr/sbin/zlogin ' + instance.uuid +
                ' "/opt/smartdc/config-agent/build/node/bin/node ' +
                '/opt/smartdc/config-agent/agent.js -f ' +
                '/opt/smartdc/config-agent/etc/config.json -s"';
            exec(cmd, next);
        },

        // Let's just do not wait for config agent to restart manatee-sitter
        function restartManateeSitter(_, next) {
            var cmd = '/usr/sbin/zlogin ' + instance.uuid +
                ' "svcadm restart manatee-sitter"';
            exec(cmd, next);
        },

        function waitForManatee(_, next) {
            var cmd = '/usr/sbin/zlogin ' + instance.uuid +
                ' "source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm ' +
                'pg-status -r primary -H -o pg-online"';

            var counter = 0;
            var limit = 36;

            function _waitForManatee() {
                counter += 1;
                exec(cmd, function pgStatusCb(err, stdout, stderr) {
                    if (err) {
                        next(err);
                        return;
                    }

                    var res = stdout.trim();
                    if (res !== 'ok') {
                       if (counter < limit) {
                          setTimeout(_waitForManatee, 5000);
                       } else {
                           next(new Error(
                               'Timeout waiting for manatee-sitter'));
                       }
                    } else {
                        next();
                    }
                });
            }
            _waitForManatee();
        },

        function enableMoray(_, next) {
            var cmd = '/usr/sbin/svcadm -z ' +
                '`/opt/smartdc/bin/sdc-vmname moray` enable \'*moray*\'';
            exec(cmd, next);
        },


        function waitForSapiStorAvailable(_, next) {
            // We're gonna attempt instances deletion, which will not work if
            // moray backend is not available. Pinging SAPI until that's not
            // a problem:
            var cmd = '/opt/smartdc/bin/sdc-sapi /ping|json -H';

            var counter = 0;
            var limit = 36;

            function _waitForSapi() {
                counter += 1;
                exec(cmd, function sapiStorAvailCb(err, stdout, stderr) {
                    if (err) {
                        next(err);
                        return;
                    }

                    var res = JSON.parse(stdout.trim());
                    if (!res.storAvailable) {
                       if (counter < limit) {
                          setTimeout(_waitForSapi, 5000);
                       } else {
                           next(new Error(
                               'Timeout waiting for SAPI to reconnect moray'));
                       }
                    } else {
                        next();
                    }
                });
            }
            _waitForSapi();
        },


        /*
         * sdc-sapi /instances/manatee1|manatee2 -X DELETE
         */
        function deleteManateeVms(ctx, next) {
            vasync.forEachPipeline({
                inputs: ctx.instsToRemove,
                func: function delInst(inst, nextInst) {
                    var cmd = 'sdc-sapi /instances/' + inst.uuid +
                        ' -X DELETE';
                    exec(cmd, nextInst);
                }
            }, next);
        }
    ];

    vasync.pipeline({
        arg: context,
        funcs: [
            /*
             * Creates Zk Client and sets it to the variable `ctx.zkc`
             */
            function createZkClient(ctx, next) {
                var zkc = new zkstream.Client({
                    address: zkHost,
                    port: 2181,
                    log: bunyan.createLogger({
                        name: 'manatee.test',
                        stream: process.stderr,
                        level: 'debug'
                    }),
                    sessionTimeout: 30000
                });
                zkc.once('connect', next);
                zkc.once('failed', function () {
                    zkc.close(function () {
                        next(new Error('Zookeeper connection failed'));
                    });
                });
                zkc.once('close', function () {
                    t.end();
                });

                ctx.zkc = zkc;
            },

            /*
             * Gets `ctx.zkState`, `ctx.zkStateRaw`
             */
            function getSdcZkState(ctx, next) {
                if (!ctx.zkc.isConnected()) {
                    next(new Error('Not connected to Zookeeper'));
                    return;
                }

                ctx.zkc.get('/manatee/sdc/state', function getCb(err, data) {
                    if (err) {
                        next(err);
                        return;
                    }
                    ctx.zkStateRaw = data.toString('ascii');
                    ctx.zkState = JSON.parse(ctx.zkStateRaw);
                    next();
                });
            },

            function runOnlyWhenNotInONWM(ctx, next) {
                if (ctx.zkState.oneNodeWriteMode) {
                    next();
                    return;
                }

                vasync.pipeline({
                    arg: ctx,
                    funcs: haFuncs
                }, next);
            }

        ]
    }, function pipeCb(pipeErr) {
        t.ok(context.zkc);
        t.ifError(pipeErr);
        context.zkc.close();
    });
});
