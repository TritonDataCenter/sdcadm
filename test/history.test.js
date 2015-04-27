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

    function getOldHistory() {
        exec('sdcadm history', function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            origHistory = parseHistory(stdout);
            origHistory.shift(); // remove column titles

            updatePapi();
        });
    }

    function updatePapi() {
        var cmd = 'sdcadm update papi --force-same-image -y';

        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            t.equal(stderr, '');

            afterUpdate = new Date();

            getNewHistory();
        });
    }

    function getNewHistory() {
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

            t.equal(newest[4], 'update-service(papi)');
            t.equal(newest[5], '-');

            t.end();
        });
    }

    getOldHistory();
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
            t.ok(entry.username == 'root' || !entry.username);
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

        t.equal(entry.changes[0].service.name, 'papi');

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
        t.ifError(err);
        t.equal(stderr, '');

        var entries = parseHistory(stdout);
        entries.shift(); // remove column titles

        entries.forEach(function (entry) {
            t.ok(entry[3] >= minimumDate);
        });

        t.end();
    });
});


test('sdcadm history --until', function (t) {
    var maximumDate = new Date(MIDDLE_ENTRY.finished).toISOString();
    var cmd = 'sdcadm history --until=' + maximumDate;

    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var entries = parseHistory(stdout);
        entries.shift(); // remove column titles

        entries.forEach(function (entry) {
            t.ok(entry[3] <= maximumDate);
        });

        t.end();
    });
});