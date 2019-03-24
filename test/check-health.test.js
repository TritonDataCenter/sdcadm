/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019, Joyent, Inc.
 */

var test = require('tape').test;
var exec = require('child_process').exec;
var util = require('util');
var vasync = require('vasync');

var common = require('./common');

var serverHostnamesFromUUID = {};
var serviceNamesFromUUID = {};
var HEALTH_TITLES = ['INSTANCE', 'SERVICE', 'HOSTNAME', 'ALIAS', 'HEALTHY'];
var HEALTH_DETAILS = [];

function checkHealthDetails(t, healthDetails) {
    healthDetails = healthDetails.map(function (item) {
        return ({
            instance: item[0],
            service: item[1],
            hostname: item[2],
            alias: item[3],
            health: item[4]
        });
    });

    common.checkInsts(t, {
        inputs: healthDetails,
        serviceNamesFromUUID: serviceNamesFromUUID,
        serverHostnamesFromUUID: serverHostnamesFromUUID
    }, function () {
        t.end();
    });
}


// ---

// Preload Servers and SAPI services
test('setup', function (t) {
    var cmd = 'sdc-sapi /services | json -H';
    exec(cmd, function sapiServicesCb(err, stdout, stderr) {
        t.ifError(err, 'No error preloading SAPI services');

        var svcs = common.parseJsonOut(stdout);
        if (!svcs) {
            t.ok(false, 'failed to parse JSON for cmd ' + cmd);
            t.end();
            return;
        }
        svcs.forEach(function (svc) {
            serviceNamesFromUUID[svc.uuid] = svc.name;
        });
        var cmd2 = 'sdc-cnapi /servers?setup=true|json -H';
        exec(cmd2, function cnapiServersCb(err2, stdout2, stderr2) {
            t.ifError(err2, 'No error preloading CNAPI servers');

            var servers = common.parseJsonOut(stdout2);
            if (!servers) {
                t.ok(false, 'failed to parse JSON for cmd ' + cmd2);
                t.end();
                return;
            }
            servers.forEach(function (server) {
                serverHostnamesFromUUID[server.uuid] = server.hostname;
            });
            t.end();
        });
    });
});

test('sdcadm check-health --help', function (t) {
    exec('sdcadm check-health --help', function helpCb(err, stdout, stderr) {
        t.ifError(err, 'exec error');

        t.ok(stdout.indexOf('sdcadm check-health [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm check-health', function (t) {
    const cmd = 'sdcadm check-health -s headnode';
    exec(cmd, function healthCb(err, stdout, stderr) {
        t.ifError(err, 'exec error');
        t.equal(stderr, '');

        common.DEFAULT_VM_SERVICES.forEach(function (svcName) {
            var found = stdout.indexOf(svcName) !== -1;
            t.ok(found, svcName + ' in instances output');
        });

        let healthDetails = common.parseTextOut(stdout);

        var titles = healthDetails.shift();
        t.deepEqual(titles, HEALTH_TITLES, 'check column titles');
        // We're interested only into the initial list of instances, not
        // the detailed explanation about each failure printed below the
        // aforementioned list:
        healthDetails = healthDetails.filter(function removeExpl(item) {
            return common.UUID_RE.test(item[0]);
        });

        for (let i = 0; i < healthDetails.length; i++) {
            let inst = healthDetails[i];
            t.equal(inst[4], 'true', inst[0] + ' instance is healthy');
        }

        // global, so other tests can compare against
        HEALTH_DETAILS = healthDetails;
        checkHealthDetails(t, common.deepCopy(healthDetails));
    });
});


test('sdcadm check-health --json', function (t) {
    const cmd = 'sdcadm check-health --json -s headnode';
    exec(cmd, function healthJsonCb(err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var details = common.parseJsonOut(stdout);
        if (!details) {
            t.ok(false, 'failed to parse JSON');
            t.end();
            return;
        }

        var healthDetails = {};
        details.forEach(function (inst) {
            healthDetails[inst.instance] = inst;
        });

        HEALTH_DETAILS.forEach(function (oldDetails) {
            var id = oldDetails[0];
            var jsonDetails = healthDetails[id];
            if (jsonDetails.type === 'global') {
                return;
            }
            t.equal(jsonDetails.type, (
                (oldDetails[3] !== '-') ? 'vm' : 'agent'
            ), id + ' type');
            t.equal(jsonDetails.service,  oldDetails[1], id + ' service');
            t.equal(jsonDetails.hostname, oldDetails[2], id + ' hostname');
            if (oldDetails[3] !== '-') {
                t.equal(jsonDetails.alias,    oldDetails[3], id + ' alias');
            }

            var oldHealthy = oldDetails[4];
            t.notEqual(['true', 'false'].indexOf(oldHealthy), -1);
            oldHealthy = (oldHealthy === 'true' ? true : false);
            t.equal(jsonDetails.healthy,  oldHealthy, id + ' hostname');
        });

        t.end();
    });
});


// TODO: this won't work on an HA standup
// TODO: simply disabling an SMF service instance is one step in test, but we
// need something more subtle yet brutal (like disabling manatee)
test('disable papi for health check', function (t) {
    const cmd = 'sdc-login papi svcadm disable papi';
    exec(cmd, function disablePapiCb(err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        t.end();
    });
});


test('sdcadm check-health with disabled papi', function (t) {
    exec('sdcadm check-health -s headnode',
        function healthPapiOff(err, stdout, stderr) {
        t.equal(err && err.code, 1, 'errcode is 1');

        t.notEqual(stderr, 'Some instances appear unhealthy'.indexOf(stderr),
                   -1);

        var unhealthyPapis = common.parseTextOut(stdout).filter(
            function (inst) {
            return inst[1] === 'papi' && inst[4] === 'false';
        });

        t.equal(unhealthyPapis.length, 1, 'unhealthy PAPI found');

        t.end();
    });
});


test('sdcadm check-health -q with disabled papi', function (t) {
    exec('sdcadm check-health -q -s headnode',
        function healthQuietCb(err, stdout, stderr) {
        t.equal(err && err.code, 1, 'errcode is 1');
        t.equal('', stderr, 'empty stderr');
        t.notEqual('', stdout, 'not empty stdout');
        t.end();
    });
});


test('enable papi after health check', function (t) {
    const cmd = 'sdc-login papi svcadm enable papi';
    exec(cmd, function enablePapiCb(err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        t.end();
    });
});

// This test can cause everything to hang if we're not correctly taking care
// of Cueball when Binder is down. (Note this assumes single binder instance
// is running into the same global zone we're running the test from):
test('check-health when binder is down', function (t) {
    vasync.pipeline({
        funcs: [
            function disableBinder(_, next) {
                exec('/usr/sbin/svcadm -z ' +
                    '`/opt/smartdc/bin/sdc-vmname binder` disable binder',
                    function disableBinderCb(err, stdout, stderr) {
                        t.ifError(err);
                        t.equal(stdout, '');
                        t.equal(stderr, '');
                        next();
                    });
            },
            function checkHealth(_, next) {
                exec('sdcadm check-health -H -s headnode',
                    function binderDisabledCb(err, stdout, stderr) {
                    t.equal(err && err.code, 1, 'errcode is 1');
                    t.equal(err.killed, false, 'process not killed');
                    t.notEqual(stdout, '', 'empty stdout');
                    t.notEqual(
                        stdout.indexOf('Binder service seems to be down'), -1,
                        'binder off stderr');
                    t.notEqual(stderr, '', 'empty stderr');
                    next();
                });
            },
            function checkHealthJson(_, next) {
                exec('sdcadm check-health -j -s headnode',
                    function binderDisabledJsonCb(err, stdout, stderr) {
                    t.equal(err && err.code, 1, 'errcode is 1');
                    t.equal(err.killed, false, 'process not killed');
                    t.equal(stderr, '');
                    var details = common.parseJsonOut(stdout);
                    if (!details) {
                        t.ok(false, 'failed to parse JSON');
                        t.end();
                        return;
                    }
                    var msg = details[0].health_errors[0].message;
                    t.ok(msg, 'err msg');
                    t.notEqual(
                        msg.indexOf('Binder service seems to be down'), -1,
                        'binder off err');
                    next();
                });
            },
            function enableBinder(_, next) {
                exec('/usr/sbin/svcadm -z ' +
                    '`/opt/smartdc/bin/sdc-vmname binder` enable binder',
                    function enableBinderCb(err, stdout, stderr) {
                        t.ifError(err);
                        t.equal(stdout, '');
                        t.equal(stderr, '');
                        next();
                    });
            }
        ]
    }, function pipeCb(pipeErr) {
        t.end(pipeErr);
    });
});

test('teardown', function (t) {

    function waitForPapi() {
        const cmd = '/opt/smartdc/bin/sdc-papi /ping|json -H';
        let counter = 0;
        const limit = 36;
        function _waitForPapi() {
            counter += 1;
            exec(cmd, function papiPingCb(err, stdout, stderr) {
                if (err) {
                    t.ifError(err);
                    t.end();
                    return;
                }

                let res;

                if (!stderr) {
                    res = JSON.parse(stdout.trim());
                }

                if (stderr || !res.backend || res.backend !== 'up') {
                   if (counter < limit) {
                      let info = stderr ? stderr :
                           'Backend error: ' + res.backend_error;
                      t.comment(util.format('Waiting for papi service (%s)',
                          info));
                      setTimeout(_waitForPapi, 5000);
                   } else {
                       t.fail('Timeout waiting for papi service');
                       t.end();
                       return;
                   }
                } else {
                    t.pass('Done waiting for papi service');
                    t.end();
                    return;
                }
            });

        }
        _waitForPapi();
    }

    function waitForHealthy() {
        const cmd = 'sdcadm check-health -q -s headnode';
        let counter = 0;
        const limit = 36;
        function _waitForHealthy() {
            counter += 1;
            exec(cmd, function healthyCb(err, stdout, stderr) {
                if (err) {
                   if (counter < limit) {
                      t.comment(util.format(
                          'Waiting for health after check-health tests'));
                      setTimeout(_waitForHealthy, 5000);
                   } else {
                       t.fail('Timeout waiting for health restored after' +
                           ' check-health tests');
                       t.end();
                       return;
                   }
                } else {
                    t.pass('Health restored after check-health tests');
                    waitForPapi();
                    return;
                }
            });

        }
        _waitForHealthy();
    }

    waitForHealthy();
});
