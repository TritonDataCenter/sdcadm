/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Missing tests for:
 *
 * - post-setup fabrics
 * - post-setup underlay-nics
 */

var util = require('util');

var test = require('tape').test;
var vasync = require('vasync');

var exec = require('child_process').exec;
var common = require('./common');
var checkHelp = common.checkHelp;
var shared = require('./shared');
var haveCommonExternalNics = shared.haveCommonExternalNics;

var externalNicsExist = false;
var vmsWithExternalNics = [];

test('setup', function (t) {
    haveCommonExternalNics(t, function haveNicsCb(err, externalNics) {
        t.ifError(err, 'haveExternalNics error');
        externalNicsExist = externalNics;
        t.end();
    });
});


test('sdcadm post-setup --help', function (t) {
    exec('sdcadm post-setup --help', function (err, stdout, stderr) {
        t.ifError(err, 'post-setup help error');

        t.ok(stdout.indexOf('sdcadm post-setup [OPTIONS] COMMAND') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm post-setup common-external-nics', function (t) {
    function checkExternal(svcName, cb) {
        var cmd = 'sdc-vmapi /vms?alias=' + svcName + ' | json -H';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var vms = JSON.parse(stdout);

            vasync.forEachPipeline({
                func: function (vm, nextVm) {
                    var external = vm.nics.filter(function (nic) {
                        return nic.nic_tag === 'external';
                    });

                    if (!externalNicsExist) {
                        vmsWithExternalNics.push(vm);
                    }

                    t.equal(external.length, 1, svcName + ' missing external');
                    nextVm();
                },
                inputs: vms
            }, function (resErr) {
                cb();
            });
        });
    }

    exec('sdcadm post-setup common-external-nics',
         function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        t.ok(stdout.indexOf('Added external nic to adminui') !== 1 ||
             stdout.indexOf('AdminUI already has an external nic') !== 1);

        t.ok(stdout.indexOf('Added external nic to imgapi') !== 1 ||
             stdout.indexOf('IMGAPI already has an external nic') !== 1);

        checkExternal('adminui', function () {
            checkExternal('imgapi', function () {
                t.end();
            });
        });
    });
});


test('sdcadm post-setup help common-external-nics', function (t) {
    checkHelp(t, 'post-setup common-external-nics',
              'Add external NICs to the adminui and imgapi zones.');
});


test('sdcadm post-setup cloudapi', function (t) {
    exec('sdcadm post-setup cloudapi', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.ok(stdout.indexOf('cloudapi0 zone created') !== 1 ||
             stdout.indexOf('Already have') !== 1);

        var cmd = 'sdc-vmapi /vms?alias=cloudapi | json -H';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            var svcs = JSON.parse(stdout2);

            t.ok(svcs.length >= 1);

            t.end();
        });
    });
});


test('sdcadm post-setup help docker', function (t) {
    checkHelp(t, 'post-setup docker',
        'Setup the Docker service.');
});


test('sdcadm post-setup docker', function (t) {
    exec('sdcadm post-setup docker', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.ok(stdout.indexOf('docker0 zone created') !== 1 ||
             stdout.indexOf('Already have') !== 1);

        var cmd = 'sdc-vmapi /vms?alias=docker | json -H';
        exec(cmd, function (err2, stdout2, stderr2) {
            t.ifError(err2);
            t.equal(stderr2, '');

            var svcs = JSON.parse(stdout2);

            t.ok(svcs.length >= 1);

            t.end();
        });
    });
});


test('sdcadm post-setup help cloudapi', function (t) {
    checkHelp(t, 'post-setup cloudapi', 'Create a first cloudapi instance.');
});


test('sdcadm post-setup dev-headnode-prov', function (t) {
    var numPolls = 20;

    function poll() {
        numPolls = numPolls - 1;

        if (numPolls === 0) {
            t.ok(false, 'CNAPI SAPI metadata did not update');
            t.end();
            return;
        }

        var cmd = 'sdc-sapi /services?name=cnapi | json -H';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var svc = JSON.parse(stdout)[0];

            if (svc.metadata.ALLOC_FILTER_CAPNESS === false &&
                svc.metadata.ALLOC_FILTER_HEADNODE === false &&
                svc.metadata.ALLOC_FILTER_MIN_RESOURCES === false) {
                t.end();
                return;
            }

            setTimeout(poll, 500); // recur in .5s
        });
    }

    exec('sdcadm post-setup dev-headnode-prov',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');


        t.ok(stdout.indexOf('Configuring CNAPI to allow') !== 1 ||
             stdout.indexOf('already configured to allow') !== 1);

        poll();
    });
});


test('sdcadm post-setup help dev-headnode-prov', function (t) {
    checkHelp(t, 'post-setup dev-headnode-prov',
              'Make the headnode provisionable, for development and testing.');
});


// Will skip until we add a search for confirmation of things happening,
// either running `sdcadm -v ...` and checking for confirmation in
// stderr, or just checking for confirmation in the system itself, figuring
// out a way of verifying things actually happening w/o using output, but
// system elements:
test.skip('sdcadm post-setup dev-sample-data', function (t) {
    var packageNames = [
        'sample-128M',
        'sample-256M',
        'sample-512M',
        'sample-1G',
        'sample-2G',
        'sample-4G',
        'sample-8G',
        'sample-16G',
        'sample-32G',
        'sample-64G'
    ];

    var imageNames = [
        'minimal',
        'base'
    ];

    function checkPkgs(pkgUuids, cb) {
        var pkgUuid = pkgUuids.shift();

        if (!pkgUuid) {
            cb();
            return;
        }

        var cmd = 'sdc-papi /packages/' + pkgUuid + ' | json -H';
        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err, 'PAPI error');
            t.equal(stderr, '', 'Empty stderr');

            var pkg = JSON.parse(stdout);
            t.equal(pkg.uuid, pkgUuid, 'PAPI has package ' + pkgUuid);

            checkPkgs(pkgUuids, cb);
        });
    }

    function checkImgs(imgUuids, cb) {
        var imgUuid = imgUuids.shift();

        if (!imgUuid) {
            cb();
            return;
        }

        var cmd = 'sdc-imgapi /images/' + imgUuid + ' | json -H';
        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err, 'IMGAPI error');
            t.equal(stderr, '', 'Empty stderr');

            var img = JSON.parse(stdout);
            t.equal(img.uuid, imgUuid, 'imgapi has image ' + imgUuid);

            checkImgs(imgUuids, cb);
        });
    }

    exec('sdcadm post-setup dev-sample-data', function (err, stdout, stderr) {
        t.ifError(err, 'Execution error');
        t.equal(stderr, '', 'Empty stderr');

        var pkgUuids = packageNames.map(function (pkg) {
            var added_re = 'Added package ' + pkg + ' \\((.+?)\\)';
            var exist_re = 'Already have package ' + pkg + ' \\((.+?)\\)';

            var match = stdout.match(added_re) || stdout.match(exist_re);
            t.ok(match, 'package added or exists: ' + pkg);

            return match[1]; // uuid
        });

        var imgUuids = imageNames.map(function printImgDetails(img) {
            console.log(img);
            console.log(util.inspect(stdout, false, 8, true));
            var added_re = 'Imported image (.+?) \n\t\\(' + img;
            var exist_re = 'Already have image (.+?) \\(' + img;
            var match = stdout.match(new RegExp(added_re, 'g')) ||
                stdout.match(new RegExp(exist_re, 'g'));
            t.ok(match, 'image added or exists: ' + img);

            return match[1]; // uuid
        });

        checkPkgs(pkgUuids, function () {
            checkImgs(imgUuids, function () {
                t.end();
            });
        });
    });
});


test('sdcadm post-setup help dev-sample-data', function (t) {
    checkHelp(t, 'post-setup dev-sample-data',
              'Add sample data suitable for *development and testing*.');
});


test('sdcadm post-setup help fabrics', function (t) {
    checkHelp(t, 'post-setup fabrics',
              'Create portolan instance and setup fabrics');
});


test('sdcadm post-setup help underlay-nics', function (t) {
    checkHelp(t, 'post-setup underlay-nics',
              'Provisions underlay NICs on the provided underlay network');
});


test('teardown', function (t) {
    if (vmsWithExternalNics.length === 0) {
        t.end();
        return;
    }

    vasync.forEachPipeline({
        func: function removeNics(vm, next) {
            var macs = vm.nics.filter(function (nic) {
                return nic.nic_tag === 'external';
            }).map(function (nic) {
                return nic.mac;
            });
            var command = 'sdc-vmapi /vms/' + vm.uuid +
                '?action=remove_nics -d \'{"macs" : [' +
                macs.join(', ') + ']}\'';
            exec(command, function execCb(err, stdout, stderr) {
                t.ifError(err, 'Execution error');
                t.equal(stderr, '', 'Empty stderr');
                next();
            });
        },
        inputs: vmsWithExternalNics
    }, function (resErr) {
        vasync.forEachParallel({
            func: function updateParamsNetworks(svc, next) {
                var command = 'echo \'{"params": {"networks": ["admin"]}}\'|' +
                    'sapiadm update $(sdc-sapi /services?name=' + svc +
                    '|json -Ha uuid)';
                exec(command, function execCb(err, stdout, stderr) {
                    t.ifError(err, 'Execution error');
                    t.equal(stderr, '', 'Empty stderr');
                    next();
                });

            },
            inputs: vmsWithExternalNics.map(function (vm) {
                return vm.tags.smartdc_role;
            })
        }, function (paraErr) {
            t.end(paraErr);
        });
    });
});
