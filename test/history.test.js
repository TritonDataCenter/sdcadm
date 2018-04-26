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

var fs = require('fs');
var exec = require('child_process').exec;
var common = require('./common');


var HISTORY_UUID = ''; // filled in later
var MIDDLE_ENTRY = []; // filled in later


function parseHistory(txt) {
    var entries = txt.split('\n');
    entries.pop();   // remove empty last item due to last \n

    entries = entries.map(function (entry) {
        return entry.split(/\s+/);
    });

    return entries;
}


test('sdcadm history --help', function (t) {
    exec('sdcadm history --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('sdcadm history [<options>]', -1));
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm history', function (t) {
    var origHistory;
    var beforeUpdate = new Date();
    var afterUpdate;

    vasync.pipeline({
        funcs: [
            function getOldHistory(_, next) {
                exec('sdcadm history', function (err, stdout, stderr) {
                    t.ifError(err);
                    t.equal(stderr, '');

                    origHistory = parseHistory(stdout);
                    origHistory.shift(); // remove column titles
                    next();
                });
            },

            function updateOther(_, next) {
                // A command that we can re-run as many times as we need
                var cmd = 'sdcadm experimental update-other';

                exec(cmd, function execCb(err, stdout, stderr) {
                    t.ifError(err);
                    t.equal(stderr, '');

                    afterUpdate = new Date();
                    next();
                });
            },

            function getNewHistory(_, next) {
                exec('sdcadm history', function (err, stdout, stderr) {
                    t.ifError(err);
                    t.equal(stderr, '');

                    var newHistory = parseHistory(stdout);
                    newHistory.shift(); // remove column titles

                    t.equal(origHistory.length + 1, newHistory.length);

                    var newest = newHistory[0];
                    t.ok(newest);

                    HISTORY_UUID = newest[0];
                    t.equal(newest[1], 'root');

                    t.ok(new Date(newest[2]) <= new Date(newest[3]));
                    t.ok(new Date(newest[2]) >= beforeUpdate);
                    t.ok(new Date(newest[3]) <= afterUpdate);

                    t.notEqual(newest[4].indexOf('update-service-cfg'), -1);
                    t.equal(newest[5], '-');

                    next();
                });
            }

        ]
    }, function (resErr) {
        t.ifError(resErr);
        t.end();
    });

});


test('sdcadm history --json', function (t) {
    exec('sdcadm history --json', { maxBuffer: 10 * 1024 * 1024 }, // 10 MiB
         function (err, stdout, stderr) {
        t.ifError(err);
        t.equal('', stderr);

        var history = JSON.parse(stdout);
        t.ok(history.length >= 1);

        history.forEach(function (entry) {
            t.ok(entry.uuid.match(common.UUID_RE), entry.uuid + ' is a UUID');
            t.ok(Array.isArray(entry.changes), 'changes is an array');
            // TODO: no username?
            t.ok(entry.username === 'root' || !entry.username);
            t.ok(new Date(entry.started));
            t.ok(new Date(entry.finished));
        });

        var historyByDate = common.deepCopy(history).sort(function (a, b) {
            return a.finished > b.finished ? -1 : 1;
        });

        MIDDLE_ENTRY = historyByDate[Math.floor(historyByDate.length / 2)];

        t.end();
    });
});


test('sdcadm history <uuid>', function (t) {
    exec('sdcadm history ' + HISTORY_UUID, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var entry = JSON.parse(stdout);
        t.equal(entry.uuid, HISTORY_UUID);
        t.equal(entry.username, 'root');
        t.equal(typeof (entry.started),  'number');
        t.equal(typeof (entry.finished), 'number');
        t.ok(Array.isArray(entry.changes));
        t.equal(entry.changes[entry.changes.length - 1].service.name, 'assets');

        t.end();
    });
});


test('sdcadm history -H', function (t) {
    exec('sdcadm history -H', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var entries = stdout.split('\n');
        t.ok(!entries[0].match('UUID'));

        t.end();
    });
});


test('sdcadm history -o', function (t) {
    exec('sdcadm history -o uuid,user', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var columns = parseHistory(stdout)[0];
        t.deepEqual(columns, ['UUID', 'USER']);

        t.end();
    });
});


test('sdcadm history -s', function (t) {
    exec('sdcadm history -s uuid', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var entries = parseHistory(stdout);
        entries.shift(); // remove column titles

        var uuids = entries.map(function (entry) {
            return entry[0];
        });

        var sorted = common.deepCopy(uuids).sort();

        t.deepEqual(uuids, sorted, 'uuids were sorted correctly');

        t.end();
    });
});


test('sdcadm history --since', function (t) {
    var minimumDate = new Date(MIDDLE_ENTRY.finished).toISOString();
    var cmd = 'sdcadm history --since=' + minimumDate;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'History since err');
        t.equal(stderr, '', 'History since stderr');

        var entries = parseHistory(stdout);
        entries.shift(); // remove column titles
        entries.forEach(function (entry) {
            t.ok(entry[2] >= minimumDate, 'History since entry ' + entry[0]);
        });

        t.end();
    });
});


test('sdcadm history --until', function (t) {
    var maximumDate = new Date(MIDDLE_ENTRY.finished).toISOString();
    var cmd = 'sdcadm history --until=' + maximumDate;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err, 'History until err');
        t.equal(stderr, '', 'History until stderr');

        var entries = parseHistory(stdout);
        entries.shift(); // remove column titles

        entries.forEach(function (entry) {
            t.ok(entry[3] <= maximumDate, 'History until entry ' + entry[0]);
        });

        t.end();
    });
});


test('sdcadm history bogus files', function (t) {
    // Create bogus file manually
    var histDir = '/var/sdcadm/history/';
    var fpath = histDir + '9887ef12-32f9-4a05-9e38-e99ca15a5758.json';

    fs.writeFile(fpath, 'null', {
        encoding: 'utf8'
    }, function (ferr) {
        t.ifError(ferr);

        // Now verify that this will not cause any error:
        var cmd = 'sdcadm experimental update-other';
        exec(cmd, function execCb(err, stdout, stderr) {
            t.ifError(err, 'Execution error');
            t.equal(stderr, '', 'Empty stderr');
            t.end();
        });
    });
});
