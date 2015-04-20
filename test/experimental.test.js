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

var DC_MAINT_START_TIME = +new Date();
var OWNER_UUID; // filled in by setup
var LATEST_AGENTS;


function checkHelp(t, subCmd, expectedStr) {
    var cmd = 'sdcadm experimental ' + subCmd + ' --help';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf(expectedStr), -1);
        t.equal(stderr, '');

        t.end();
    });
}


test('setup', function (t) {
    // run this in case we don't have those nics yet
    exec('sdcadm post-setup common-external-nics',
         function (err, stdout, stderr) {
        t.ifError(err);

        var cmd = 'sdc-ufds s "(login=admin)" | json uuid';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);

            OWNER_UUID = stdout2.split('\n')[0];
            t.ok(OWNER_UUID, 'owner_uuid found');

            t.end();
        });
    });
});


test('sdcadm experimental --help', function (t) {
    checkHelp(t, '', 'sdcadm experimental [OPTIONS] COMMAND');
});


test('sdcadm experimental update-agents --help', function (t) {
    checkHelp(t, 'update-agents', 'experimental update-agents IMAGE-UUID');
});


test('sdcadm experimental update-agents --force --latest --yes', function (t) {
    exec('sdcadm experimental update-agents --force --latest --yes',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        if (!stdout.match('The file was already downloaded to')) {
            var match = stdout.match(/file version is: master-(\d{8}t\d{6}z)/i);

            if (match) {
                var origTimestamp = match[1];
                match = stdout.match(/Download.+?\(.+?master-(\d{8}t\d{6}z)/i);
                var newTimestamp = match[1];

                t.ok(newTimestamp >= origTimestamp, 'new shar is newer');
            }
        } else {
            t.ok(stdout.match('Using agent .+ from previous download'));
        }

        t.ok(stdout.match('Executing agents installer across data center'));
        t.ok(stdout.match('Done'));

        t.end();
    });
});


// TODO: shouldn't stderr and stdout be switched here?
test('sdcadm experimental update-agents --latest --yes', function (t) {
    exec('sdcadm experimental update-agents --latest --yes',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.ok(stdout.match('The file was already downloaded to'));
        t.ok(stdout.match('provide --force option if you want to run it'));

        var match = stdout.match('Latest agents file version is: (.+)');
        LATEST_AGENTS = match && match[1];
        t.ok(LATEST_AGENTS, 'found latest agents file uuid');

        t.end();
    });
});


test('sdcadm experimental update-agents <img uuid>', function (t) {
    var cmd = 'sdcadm experimental update-agents ' + LATEST_AGENTS +
              ' --force --yes';

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var expected = [
            'The file was already downloaded to',
            'Executing agents installer across data center',
            'Done'
        ];

        expected.forEach(function (str) {
            t.ok(stdout.match(str), 'Find in output: ' + str);
        });

        t.end();
    });
});


test('sdcadm experimental dc-maint --help', function (t) {
    checkHelp(t, 'dc-maint', 'Show and modify the DC maintenance mode');
});


test('sdcadm experimental dc-maint --start', function (t) {
    DC_MAINT_START_TIME = +new Date();

    var cmd = 'sdcadm experimental dc-maint --start';
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var expectedStr = [
            'Putting cloudapi in read-only mode',
            'Waiting up to 5 minutes for workflow jobs to drain',
            'Workflow cleared of running and queued jobs'
        ];

        expectedStr.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1, 'Match: ' + str);
        });

        // check jobs are drained
        var cmd2 = 'sdc-workflow /jobs | json -Ha execution';
        exec(cmd2, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            t.ifError(stdout2.match('queued'), 'jobs still queued');
            t.ifError(stdout2.match('running'), 'jobs still running');

            // TODO: check cloudapi is read-only
            t.end();
        });
    });
});


test('sdcadm experimental dc-maint (part 1)', function (t) {
    exec('sdcadm experimental dc-maint', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        // JSSTYLED
        var match = stdout.match(/DC maintenance: on \(since (.+)\)/);
        t.ok(match);

        var started = match[1];
        t.ok(+new Date(started) > DC_MAINT_START_TIME);

        t.end();
    });
});


test('sdcadm experimental dc-maint --json (part 1)', function (t) {
    exec('sdcadm experimental dc-maint --json', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var status = JSON.parse(stdout);
        t.deepEqual(Object.keys(status).sort(), ['maint', 'startTime']);

        t.equal(status.maint, true);
        t.ok(+new Date(status.startTime) > DC_MAINT_START_TIME);

        t.end();
    });
});


test('sdcadm experimental dc-maint --stop', function (t) {
    exec('sdcadm experimental dc-maint --stop', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('Taking cloudapi out of read-only mode'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm experimental dc-maint (part 2)', function (t) {
    exec('sdcadm experimental dc-maint', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('DC maintenance: off'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm experimental dc-maint --json (part 2)', function (t) {
    exec('sdcadm experimental dc-maint --json', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var status = JSON.parse(stdout);
        t.deepEqual(status, { maint: false });

        t.end();
    });
});


test('sdcadm experimental update-other --help', function (t) {
    var expected = 'Temporary grabbag for small SDC update steps';
    checkHelp(t, 'update-other', expected);
});


test('sdcadm experimental update-other', function (t) {
    var mahiDomain = '';
    var papiDomain = '';
    var sapiUrl    = '';

    function runUpdate() {
        exec('sdcadm experimental update-other',
             function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var expected = [
                'Updating maintain_resolvers for all vm services',
                'Updating DNS domain service metadata for papi, mahi',
                'Updating DNS domain SDC application metadata for papi, mahi',
                'Done'
            ];

            expected.forEach(function (str) {
                t.notEqual(stdout.indexOf(str), -1, 'output contains: ' + str);
            });

            checkDomains();
        });
    }

    function checkDomains() {
        var cmd = 'sdc-sapi /applications?name=sdc | json -H';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var sdc = JSON.parse(stdout)[0];
            t.ok(sdc);

            mahiDomain = sdc.metadata.MAHI_SERVICE;
            papiDomain = sdc.metadata.PAPI_SERVICE;
            sapiUrl    = sdc.metadata['sapi-url'];

            t.ok(mahiDomain);
            t.ok(papiDomain);
            t.ok(sapiUrl);

            checkServices();
        });
    }

    function checkServices() {
        exec('sdc-sapi /services | json -H', function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var services = JSON.parse(stdout);

            var vms = services.filter(function (svc) {
                return svc.type === 'vm';
            });

            var mahi = services.filter(function (svc) {
                return svc.name === 'mahi';
            })[0];

            var papi = services.filter(function (svc) {
                return svc.name === 'papi';
            })[0];

            t.ok(mahi, 'mahi service present');
            t.ok(papi, 'papi service present');

            t.equal(mahi.metadata.SERVICE_DOMAIN, mahiDomain);
            t.equal(papi.metadata.SERVICE_DOMAIN, papiDomain);

            t.equal(sapiUrl, mahi.metadata['sapi-url']);
            t.equal(sapiUrl, papi.metadata['sapi-url']);

            vms.forEach(function (vm) {
                t.equal(vm.params.maintain_resolvers, true,
                        vm.name + ' name has maintain_resolvers');
            });

            t.end();
        });
    }

    runUpdate();
});


test('sdcadm experimental update-gz-tools --help', function (t) {
    checkHelp(t, 'update-gz-tools', 'experimental update-gz-tools IMAGE-UUID');
});


test('sdcadm experimental update-gz-tools --latest', function (t) {
    exec('sdcadm experimental update-gz-tools --latest',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var expected = [
            'Downloading gz-tools image',
            'Updating "sdc" zone tools',
            'Updating global zone scripts',
            'Updating cn_tools on all compute nodes',
            'Updated gz-tools successfully'
        ];

        expected.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1, 'output contains: ' + str);
        });

        // TODO: more sanity checks

        t.end();
    });
});


test('sdcadm experimental update-gz-tools <img uuid>', function (t) {
    // TODO
    t.end();
});


test('sdcadm experimental add-new-agent-svcs --help', function (t) {
    var expected = 'Temporary grabbag for installing the SDC global zone new';
    checkHelp(t, 'add-new-agent-svcs', expected);
});


test('sdcadm experimental add-new-agent-svcs', function (t) {
    exec('sdcadm experimental add-new-agent-svcs',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var expected = [
            'Getting SDC\'s SAPI service details from SAPI',
            'Getting SDC\'s sapi instances from SAPI',
            'Getting sapi VM details from VMAPI',
            'Getting sapi Image details from IMGAPI',
            'Checking for minimum SAPI version',
            'Checking if service \'vm-agent\' exists',
            'Checking if service \'net-agent\' exists',
            'Checking if service \'cn-agent\' exists',
            'Add new agent services finished'
        ];

        expected.forEach(function (str) {
            t.notEqual(stdout.indexOf(str), -1, 'output contains: ' + str);
        });

        exec('svcs | grep online', function (err2, stdout2, stderr2) {
            t.ifError(err2);

            t.ok(stdout.match('vm-agent'),  'vm-agent SMF service exists');
            t.ok(stdout.match('cn-agent'),  'cn-agent SMF service exists');
            t.ok(stdout.match('net-agent'), 'net-agent SMF service exists');

            t.end();
        });
    });
});


test('sdcadm experimental update-docker --help', function (t) {
    checkHelp(t, 'update-docker', 'Add/update the docker service');
});


test('sdcadm experimental update-docker --force', function (t) {
    exec('sdcadm experimental update-docker --force',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        if (stdout.match('Reprovisioning "docker"')) {
            t.ok(stdout.match('Reprovisioned "docker"'));
        } else {
            var expected = [
                'Creating "docker" service',
                'Creating "hostvolume" service',
                'Creating "nat" service',
                'Creating "docker" instance',
                'Update "docker" key in CLOUDAPI_SERVICES'
            ];

            expected.forEach(function (str) {
                t.notEqual(stdout.indexOf(str), -1, 'output contains: ' + str);
            });
        }

        t.ok(stdout.match('Updated SDC Docker'));

        exec('sdc-sapi /services?name=cloudapi | json -H',
             function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            var cloudapi = JSON.parse(stdout2)[0];

            // in case cloudapi isn't set up yet
            if (cloudapi) {
                t.ok(cloudapi.metadata.CLOUDAPI_SERVICES,
                     'CLOUDAPI_SERVICES set');

                var services = JSON.parse(cloudapi.metadata.CLOUDAPI_SERVICES);
                t.ok(services.docker, 'docker service set');
            }

            exec('vmadm list', function (err3, stdout3, stderr3) {
                t.ifError(err3);
                t.equal(stderr3, '');

                t.ok(stdout3.match('docker'));
                t.ok(stdout3.match('hostvolume-headnode'));

                t.end();
            });
        });
    });
});


test('sdcadm experimental update-docker', function (t) {
    exec('sdcadm experimental update-docker', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.match('Updated SDC Docker'));
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm experimental portolan --help', function (t) {
    checkHelp(t, 'portolan', 'Add/update the portolan service');
});


test('sdcadm experimental portolan --force', function (t) {
    exec('sdcadm experimental portolan --force',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        if (!stdout.match('Reprovision "portolan"')) {
            t.ok(stdout.match('Creating "portolan" service'));
            t.ok(stdout.match('Creating "portolan" instance'));
        }

        t.ok(stdout.match('Updated portolan'));

        exec('vmadm list', function (err2, stdout2, stderr2) {
            t.ifError(err2);

            t.ok(stdout.match('portolan'), 'portolan zone found');
            t.equal(stderr2, '');

            t.end();
        });
    });
});


test('sdcadm experimental portolan', function (t) {
    exec('sdcadm experimental portolan', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.ok(stdout.match('Reprovision "portolan"'));
        t.ok(stdout.match('Updated portolan'));

        t.end();
    });
});


test('sdcadm experimental fabrics --help', function (t) {
    checkHelp(t, 'fabrics', 'Initialize fabrics in the datacenter');
});


test('sdcadm experimental fabrics --force', function (t) {
    exec('sdcadm experimental fabrics --force', function (err, stdout, stderr) {
        t.ok(err);
        t.equal(stdout, '');
        t.notEqual(stderr.indexOf('"-c conf" or "--coal" is required'), -1);
        t.end();
    });
});


test('sdcadm experimental fabrics --force --coal', function (t) {
    function runFabrics() {
        exec('sdcadm experimental fabrics --force --coal',
             function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var expected = [
                'Initialize fabrics for CoaL',
                'Ensure services using "fabric_cfg"',
                'Successfully added default fabric',
                'Setting up CoaL HN fabric',
                'Writing boot-time networking file to USB key',
                'Successfully initialized fabric sub-system'
            ];

            expected.forEach(function (str) {
                t.notEqual(stdout.indexOf(str), -1, 'output contains: ' + str);
            });

            t.ok(stdout.match('Created default fabric VLAN') ||
                 stdout.match('Already have default fabric VLAN'));

            t.ok(stdout.match('Created default fabric network') ||
                 stdout.match('Already have default fabric network'));

            checkPools();
        });
    }

    function checkPools() {
        var cmd = 'sdc-napi /network_pools | json -H';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);

            var pools = JSON.parse(stdout);
            var natPools = pools.filter(function (pool) {
                return pool.name === 'sdc_nat';
            });

            t.equal(natPools.length, 1);

            checkNetworks();
        });
    }

    function checkNetworks() {
        var cmd = 'sdc-napi /networks?name=sdc_underlay | json -H';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);

            var networks = JSON.parse(stdout);
            t.equal(networks.length, 1);
            t.equal(networks[0].name, 'sdc_underlay');

            checkTags();
        });
    }

    function checkTags() {
        exec('sdc-napi /nic_tags | json -H', function (err, stdout, stderr) {
            t.ifError(err);

            var tags = JSON.parse(stdout);
            var underlayTags = tags.filter(function (tag) {
                return tag.name === 'sdc_underlay';
            });

            t.equal(underlayTags.length, 1);

            checkVlans();
        });
    }

    function checkVlans() {
        var cmd = 'sdc-napi /fabrics/' + OWNER_UUID + '/vlans | json -H';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var vlan = JSON.parse(stdout)[0];
            t.equal(vlan.name, 'default');

            t.end();
        });
    }

    runFabrics();
});


test('sdcadm experimental default-fabric --help', function (t) {
    checkHelp(t, 'default-fabric', 'Initialize a default fabric');
});


test('sdcadm experimental default-fabric', function (t) {
    var cmd = 'sdcadm experimental default-fabric ' + OWNER_UUID;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var expected = [
            'have default fabric VLAN',
            'have default fabric network',
            'added default fabric'
        ];

        expected.forEach(function (str) {
            t.ok(stdout.match(str));
        });

        t.end();
    });
});
