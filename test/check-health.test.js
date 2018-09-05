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
    exec(cmd, function (err, stdout, stderr) {
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
        exec(cmd2, function (err2, stdout2, stderr2) {
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
    exec('sdcadm check-health --help', function (err, stdout, stderr) {
        t.ifError(err, 'exec error');

        t.ok(stdout.indexOf('sdcadm check-health [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm check-health', function (t) {
    exec('sdcadm check-health', function (err, stdout, stderr) {
        t.ifError(err, 'exec error');
        t.equal(stderr, '');

        common.DEFAULT_VM_SERVICES.forEach(function (svcName) {
            var found = stdout.indexOf(svcName) !== -1;
            t.ok(found, svcName + ' in instances output');
        });

        var healthDetails = common.parseTextOut(stdout);

        var titles = healthDetails.shift();
        t.deepEqual(titles, HEALTH_TITLES, 'check column titles');

        healthDetails.forEach(function (inst) {
            t.equal(inst[4], 'true', inst[0] + ' instance is healthy');
        });

        // global, so other tests can compare against
        HEALTH_DETAILS = healthDetails;
        checkHealthDetails(t, common.deepCopy(healthDetails));
    });
});


test('sdcadm check-health -H', function (t) {
    exec('sdcadm check-health -H', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.equal(stdout.indexOf('INSTANCE'), -1);

        t.end();
    });
});


test('sdcadm check-health --json', function (t) {
    exec('sdcadm check-health --json', function (err, stdout, stderr) {
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


test('sdcadm check-health -q', function (t) {
    exec('sdcadm check-health -q', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stdout, '');
        t.equal(stderr, '');

        t.end();
    });
});


// TODO: this won't work on an HA standup
// TODO: simply disabling an SMF service instance is one step in test, but we
// need something more subtle yet brutal (like disabling manatee)
test('disable papi for health check', function (t) {
    exec('sdc-login papi svcadm disable papi', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        t.end();
    });
});


test('sdcadm check-health with disabled papi', function (t) {
    exec('sdcadm check-health', function (err, stdout, stderr) {
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
    exec('sdcadm check-health -q', function (err, stdout, stderr) {
        t.equal(err && err.code, 1, 'errcode is 1');
        t.equal('', stderr, 'empty stderr');
        t.notEqual('', stdout, 'not empty stdout');
        t.end();
    });
});


test('enable papi after health check', function (t) {
    exec('sdc-login papi svcadm enable papi', function (err, stdout, stderr) {
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
                exec('sdcadm check-health -H', function (err, stdout, stderr) {
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
                exec('sdcadm check-health -j', function (err, stdout, stderr) {
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
