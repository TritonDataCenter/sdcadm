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
var common = require('./common');


var SERVICE_TITLES = ['TYPE', 'UUID', 'NAME', 'IMAGE', 'INSTS'];
var SERVICES_INFO = {};
var SERVICES_DETAILS = [];


function checkHelp(t, command) {
    exec('sdcadm ' + command + ' --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm services [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
}


function parseServicesOutput(t, output, expectedTitles) {
    var servicesDetails = common.parseTextOut(output);
    t.ok(servicesDetails.length > 0);

    var titles = servicesDetails.shift();
    t.deepEqual(titles, expectedTitles || SERVICE_TITLES,
                'check service titles present');

    return servicesDetails.filter(function (r) {
        // TODO: we should check validity of non-sapi-registered entries as well
        return r[1] !== '-';
    });
}


/*
 * Recursive function to check the existence of a service, and its type, name,
 * image, and instances count are correct.
 */
function checkServicesDetails(t, servicesDetails) {
    if (servicesDetails.length === 0) {
        return t.end();
    }

    function recur() {
        return checkServicesDetails(t, servicesDetails);
    }

    var serviceDetails = servicesDetails.pop();
    var type     = serviceDetails[0];
    var svcUuid  = serviceDetails[1];
    var name     = serviceDetails[2];
    var imgUuid  = serviceDetails[3];
    var numInsts = +serviceDetails[4];

    t.notEqual(['vm', 'agent'].indexOf(type), -1, svcUuid + ' service type');

    if (svcUuid === '-') {
        return recur();
    }

    var svcInfo = SERVICES_INFO[svcUuid];

    t.equal(svcInfo.type, type, svcUuid + ' service type matches');
    t.equal(svcInfo.name, name, svcUuid + ' service name matches');

    if (imgUuid === '-') {
        return recur();
    }

    t.equal(svcInfo.params.image_uuid, imgUuid);

    var cmd = 'sdc-imgapi /images/' + imgUuid + ' | json -H';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, svcUuid + ' service image exists');

        if (type !== 'vm') {
            return recur();
        }

        var cmd2 = 'sdc-sapi /instances?service_uuid=' + svcUuid + ' | json -H';

        exec(cmd2, function (err2, stdout2, stderr2) {
            t.ifError(err2, svcUuid + ' service instance fetch');

            var instances = common.parseJsonOut(stdout2);
            if (!instances) {
                t.ok(false, 'failed to parse JSON for cmd ' + cmd2);
                return recur();
            }

            t.equal(instances.length, numInsts);
            instances.forEach(function (inst) {
                t.equal(inst.service_uuid, svcUuid); // sanity check
            });

            checkInstancesExist(t, instances, recur);
        });
    });
}


function checkInstancesExist(t, instances, cb) {
    if (instances.length === 0) {
        return cb();
    }

    var instance = instances.pop();
    var vmUuid = instance.uuid;
    var cmd = 'sdc-vmapi /vms/' + vmUuid + ' | json -H';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'check service instance ' + vmUuid + ' actually exists');

        var instanceDetails = common.parseJsonOut(stdout);
        if (!instanceDetails) {
            t.ok(false, 'failed to parse JSON for cmd ' + cmd);
            return checkInstancesExist(t, instances, cb);
        }

        t.equal(instanceDetails.uuid, instance.uuid); // sanity check

        checkInstancesExist(t, instances, cb);
    });
}


// ---


test('setup', function (t) {
    exec('sdc-sapi /services | json -H', function (err, stdout, stderr) {
        t.ifError(err);

        var servicesInfo = common.parseJsonOut(stdout);
        if (!servicesInfo) {
            t.ok(false, 'failed to parse JSON to preload service info');
            return t.end();
        }

        servicesInfo.forEach(function (svc) {
            SERVICES_INFO[svc.uuid] = svc;
        });

        t.end();
    });
});


test('sdcadm services --help', function (t) {
    checkHelp(t, 'services');
});


test('sdcadm svcs --help', function (t) {
    checkHelp(t, 'svcs');
});


test('sdcadm services', function (t) {
    exec('sdcadm services', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        common.DEFAULT_SERVICES.forEach(function (svcName) {
            var found = stdout.indexOf(svcName) !== -1;
            t.ok(found, svcName + ' in instances output');
        });

        // global, so other tests can compare against
        SERVICES_DETAILS = parseServicesOutput(t, stdout);

        checkServicesDetails(t, common.deepCopy(SERVICES_DETAILS));
    });
});


test('sdcadm svcs', function (t) {
    exec('sdcadm svcs', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.deepEqual(parseServicesOutput(t, stdout), SERVICES_DETAILS);

        t.end();
    });
});


test('sdcadm services -H', function (t) {
    exec('sdcadm services -H', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.equal(stdout.indexOf('UUID'), -1);

        t.end();
    });
});


test('sdcadm services --json', function (t) {
    exec('sdcadm services --json', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var details = common.parseJsonOut(stdout);
        if (!details) {
            t.ok(false, 'failed to parse JSON');
            return t.end();
        }

        var svcDetails = {};
        details.forEach(function (svc) {
            t.ok(svc.name, 'service name present');
            t.ok(svc.type, 'service type present');
            t.equal(typeof (svc.insts), 'number', 'service insts present');

            if (svc.uuid) {
                svcDetails[svc.uuid] = svc;
            }
        });

        SERVICES_DETAILS.forEach(function (oldDetails) {
            var svcUuid = oldDetails[1];
            var jsonDetails = svcDetails[svcUuid];
            t.equal(jsonDetails.type,  oldDetails[0],  svcUuid + ' type');
            t.equal(jsonDetails.name,  oldDetails[2],  svcUuid + ' name');
            t.equal(jsonDetails.insts, +oldDetails[4], svcUuid + ' insts');

            if (oldDetails[3] !== '-') {
                t.equal(jsonDetails.params.image_uuid, oldDetails[3],
                        svcUuid + ' hostname');
            }
        });

        t.end();
    });
});


test('sdcadm services -o', function (t) {
    var cmd = 'sdcadm services -o type,uuid,name';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        function relevant(data) {
            return data.map(function (r) {
                return [ r[1], r[2] ];
            });
        }

        var services = parseServicesOutput(t, stdout, ['TYPE', 'UUID', 'NAME']);

        t.deepEqual(relevant(services), relevant(SERVICES_DETAILS));

        t.end();
    });
});


test('sdcadm services -s', function (t) {
    exec('sdcadm services -s name', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var services = parseServicesOutput(t, stdout);
        var sortedSvcs = common.deepCopy(services).sort(function (a, b) {
            return (a[2] < b[2]) ? -1 : 1;
        });

        t.deepEqual(services, sortedSvcs);

        t.end();
    });
});
