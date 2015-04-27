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
var checkHelp = require('./common').checkHelp;


test('sdcadm post-setup --help', function (t) {
    exec('sdcadm post-setup --help', function (err, stdout, stderr) {
        t.ifError(err);

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

            var svcs = JSON.parse(stdout);

            // TODO: change to work in HA environment
            var external = svcs[0].nics.filter(function (nic) {
                return nic.nic_tag === 'external';
            });

            t.equal(external.length, 1, svcName + ' missing external');

            cb();
        });
    }

    exec('sdcadm post-setup common-external-nics',
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

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


test('sdcadm post-setup help cloudapi', function (t) {
    checkHelp(t, 'post-setup cloudapi', 'Create a first cloudapi instance.');
});


test('sdcadm post-setup dev-headnode-prov', function (t) {
    var numPolls = 20;

    function poll() {
        numPolls = numPolls - 1;

        if (numPolls === 0) {
            t.ok(false, 'CNAPI SAPI metadata did not update');
            return t.end();
        }

        var cmd = 'sdc-sapi /services?name=cnapi | json -H';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var svc = JSON.parse(stdout)[0];

            if (svc.metadata.ALLOC_FILTER_HEADNODE === false &&
                svc.metadata.ALLOC_FILTER_MIN_RESOURCES === false) {
                return t.end();
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


test('sdcadm post-setup dev-sample-data', function (t) {
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
            return cb();
        }

        var cmd = 'sdc-papi /packages/' + pkgUuid + ' | json -H';
        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var pkg = JSON.parse(stdout);
            t.equal(pkg.uuid, pkgUuid, 'PAPI has package ' + pkgUuid);

            checkPkgs(pkgUuids, cb);
        });
    }

    function checkImgs(imgUuids, cb) {
        var imgUuid = imgUuids.shift();

        if (!imgUuid) {
            return cb();
        }

        var cmd = 'sdc-imgapi /images/' + imgUuid + ' | json -H';
        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            var img = JSON.parse(stdout);
            t.equal(img.uuid, imgUuid, 'imgapi has image ' + imgUuid);

            checkImgs(imgUuids, cb);
        });
    }

    exec('sdcadm post-setup dev-sample-data', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var pkgUuids = packageNames.map(function (pkg) {
            var added_re = 'Added package ' + pkg + ' \\((.+?)\\)';
            var exist_re = 'Already have package ' + pkg + ' \\((.+?)\\)';

            var match = stdout.match(added_re) || stdout.match(exist_re);
            t.ok(match, 'package added or exists: ' + pkg);

            return match[1]; // uuid
        });

        var imgUuids = imageNames.map(function (img) {
            var added_re = 'Imported image (.+?) \\(' + img;
            var exist_re = 'Already have image (.+?) \\(' + img;

            var match = stdout.match(added_re) || stdout.match(exist_re);
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


test('sdcadm post-setup zookeeper', function (t) {
    exec('sdcadm post-setup zookeeper', function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.notEqual(stderr.indexOf('Must specify 1 servers'), -1);

        t.end();
    });
});


test('sdcadm post-setup zookeeper --members', function (t) {
    exec('sdcadm post-setup zookeeper -m 4', function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.notEqual(stderr.indexOf('Must specify 3 servers'), -1);

        t.end();
    });
});


test('sdcadm post-setup zookeeper --servers', function (t) {
    var serverUuids = '';

    exec('sdcadm post-setup zookeeper -s ' + serverUuids,
         function (err, stdout, stderr) {
        // TODO
        t.end();
    });
});


test('sdcadm post-setup help zookeeper', function (t) {
    checkHelp(t, 'post-setup zookeeper',
              'Create a zookeeper cluster, known as an ensemble');
});


test('sdcadm post-setup ha-manatee', function (t) {
    exec('sdcadm post-setup ha-manatee', function (err, stdout, stderr) {
        t.ok(err);

        t.equal(stdout, '');
        t.notEqual(stderr.indexOf('Must specify 2 target servers'), -1);

        t.end();
    });
});


test('sdcadm post-setup ha-manatee --servers', function (t) {
    var serverUuids = '';

    exec('sdcadm post-setup ha-manatee -s' + serverUuids,
         function (err, stdout, stderr) {
        // TODO
        t.end();
    });
});


test('sdcadm post-setup help ha-manatee', function (t) {
    checkHelp(t, 'post-setup ha-manatee',
              'Create 2nd and 3rd manatee instances');
});
