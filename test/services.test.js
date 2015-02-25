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


var SERVICES_DETAILS = [];


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

        // global, so other tests can compare against
        SERVICES_DETAILS = parseServicesOutput(stdout);
        t.ok(SERVICES_DETAILS.length > 0);

        checkServicesDetails(t, deepCopy(SERVICES_DETAILS));
    });
});


test('sdcadm svcs', function (t) {
    exec('sdcadm svcs', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.deepEqual(parseServicesOutput(stdout), SERVICES_DETAILS);
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

        var details;
        try {
            details = JSON.parse(stdout);
        } catch (e) {
            t.ok(false, 'parse --json output');
            details = {};
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

        var data = stdout.split('\n').filter(function (r) {
            return r !== '';
        }).map(function (r) {
            return r.split(/\s+/);
        });

        var titles = data.shift();

        t.deepEqual(titles, ['TYPE', 'UUID', 'NAME']);

        var services = data.filter(function (r) {
            return r[1] !== '-';
        }).map(function (r) {
            return [ r[1], r[2] ];
        });

        var prevSvcs = SERVICES_DETAILS.map(function (r) {
            return [ r[1], r[2] ];
        });

        t.deepEqual(services, prevSvcs);

        t.end();
    });
});


test('sdcadm services -s', function (t) {
    exec('sdcadm services -s name', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var services = parseServicesOutput(stdout);
        var sortedSvcs = deepCopy(services).sort(function (a, b) {
            if (a[2] < b[2]) {
                return -1;
            }
            return 1;
        });

        t.deepEqual(services, sortedSvcs);

        t.end();
    });
});


function checkHelp(t, command) {
    exec('sdcadm ' + command + ' --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm services [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
}


function parseServicesOutput(output) {
    return output.split('\n').filter(function (r) {
        return r !== '';
    }).map(function (r) {
        return r.split(/\s+/);
    }).filter(function (r) {
        // first row of output is column titles, which we don't want
        return r[0] !== 'TYPE';
    }).filter(function (r) {
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

    var serviceDetails = servicesDetails.pop();
    var type     = serviceDetails[0];
    var svcUuid  = serviceDetails[1];
    var name     = serviceDetails[2];
    var imgUuid  = serviceDetails[3];
    var numInsts = +serviceDetails[4];

    t.notEqual(['vm', 'agent'].indexOf(type), -1, svcUuid + ' service type');

    if (svcUuid === '-') {
        return checkServicesDetails(t, servicesDetails); // recur
    }

    var cmd = 'sdc-sapi /services/' + svcUuid + ' | json -H';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        var svcInfo = JSON.parse(stdout);
        t.equal(svcInfo.type, type, svcUuid + ' service type matches');
        t.equal(svcInfo.name, name, svcUuid + ' service name matches');

        if (imgUuid === '-') {
            return checkServicesDetails(t, servicesDetails); // recur
        }

        t.equal(svcInfo.params.image_uuid, imgUuid);

        var cmd2 = 'sdc-imgapi /images/' + imgUuid + ' | json -H';

        exec(cmd2, function (err2, stdout2, stderr2) {
            t.ifError(err2, svcUuid + ' service image exists');

            if (type !== 'vm') {
                return checkServicesDetails(t, servicesDetails); // recur
            }

            var cmd3 = 'sdc-sapi /instances?service_uuid=' + svcUuid +
                ' | json -H';

            exec(cmd3, function (err3, stdout3, stderr3) {
                t.ifError(err3, svcUuid + ' service instance fetch');

                var instances = JSON.parse(stdout3);
                t.equal(instances.length, numInsts);
                instances.forEach(function (inst) {
                    t.equal(inst.service_uuid, svcUuid); // sanity check
                });

                checkInstancesExist(t, instances, function () {
                    checkServicesDetails(t, servicesDetails); // recur
                });
            });
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

        var instanceDetails = JSON.parse(stdout);
        t.equal(instanceDetails.uuid, instance.uuid); // sanity check

        checkInstancesExist(t, instances, cb);
    });
}


function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj)); // heh
}
