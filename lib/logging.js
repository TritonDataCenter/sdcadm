/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Logging handling for sdcadm. The plan:
 *
 * - We use Bunyan for logging.
 * - We log level WARN and above to stderr (for now).
 * - We sometimes log level TRACE (i.e. all levels) to files under
 *   "/var/log/sdcadm/logs". A log *file* is create if (a) the subcommand is
 *   one that makes system changes; or (b) the subcommand errors out (we
 *   buffer log records in mem and dump on error). Log files for `sdcadm`
 *   invocations are written to
 *   "/var/log/sdcadm/logs/$timestamp-$pid-$subcommand.log",
 *   e.g. "1399408575216-002974-update.log"
 * - Then the intention is to have a logadm.conf entry as follows:
 *          sdcadm_logs /var/log/sdcadm/sdcadm.log \
 *              -b '/opt/smartdc/sdcadm/tools/rotate-logs.sh \
 *              -i /var/log/sdcadm/logs/ /var/log/sdcadm/sdcadm.log' \
 *              -t '/var/log/sdcadm/sdcadm_$nodename_%FT%H:%M:%S.log' \
 *              -C 168 -S 1g -p 1h
 *   for hourly rollup and rotation of these logs (with a week's worth
 *   retention up to 1 GiB).
 * - Then the intention is a hermes config (in the 'sdc' zone) to upload those
 *   hourly rotated logs to manta:
 *          {
 *            "name": "sdcadm_logs",
 *            "search_dirs": [ "/var/log/sdcadm" ],
 *            "regex": "^/var/log/sdcadm/sdcadm_([0-9a-zA-Z-]+)_([0-9]+)
 *                  -([0-9]+)-([0-9]+)T([0-9]+):([0-9]+):([0-9]+)\\.log$",
 *            "manta_path": "/%u/stor/logs/%d/sdcadm/#y/#m/#d/#H/$1.log",
 *            "date_string": {
 *              "y": "$2", "m": "$3", "d": "$4",
 *              "H": "$5", "M": "$6", "S": "$7"
 *            },
 *            "date_adjustment": "-1H",
 *            "debounce_time": 600,
 *            "retain_time": 86400,
 *            "zones": [
 *              "global"
 *            ]
 *          },
 *
 * Dev notes:
 * - This module borrows from fwadm's /usr/fw/lib/util/log.js
 * - The log rollup script borrows from /usr/vm/sbin/rotate-logs.sh
 *   and the rollup/rotation scheme mirrors that for vm and fw logs in the
 *   platform.
 *
 */

var p = console.log;
var assert = require('assert-plus');
var bunyan = require('bunyan');
var events = require('events');
var fs = require('fs');
var mkdirp = require('mkdirp');
var mod_uuid = require('node-uuid');
var path = require('path');
var restify = require('sdc-clients/node_modules/restify');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');



// --- Globals

var LOG_DIR = '/var/log/sdcadm/logs';



// --- Internal helper functions

/**
 * Bunyan serializer for a firewall rule
 */
function fullRuleSerializer(rules) {
    var res = {};
    for (var r in rules) {
        res[rules[r].uuid] = rules[r].toString();
    }

    return Object.keys(res).map(function (u) {
        return res[u];
    });
}


/**
 * Returns true if the bunyan stream is logging to LOG_DIR
 */
function isLoggingToFile(str) {
    if (str.type === 'file' && str.stream &&
        startsWith(str.path, LOG_DIR))
    {
        return true;
    }

    return false;
}


/**
 * Returns true if the bunyan stream is an OpenOnErrorFileStream
 */
function isOnErrorStream(str) {
    if (str.type === 'raw' && str.stream &&
        str.stream instanceof OpenOnErrorFileStream)
    {
        return true;
    }

    return false;
}


/**
 * Bunyan serializer for just the rule UUID
 */
function ruleSerializer(rules) {
    var res = {};
    for (var r in rules) {
        res[rules[r].uuid] = rules[r].toString();
    }

    return Object.keys(res);
}


/**
 * Taken from jsprim
 */
function startsWith(str, prefix)
{
    return (str.substr(0, prefix.length) == prefix);
}


/**
 * Bunyan serializer for just the VM UUID
 */
function vmSerializer(vms) {
    // Returning from add, update, etc, vms is a list of VM UUIDs
    if (util.isArray(vms)) {
        if (typeof (vms[0]) === 'string') {
            return vms;
        }

        return vms.map(function (v) {
            return v.hasOwnProperty('uuid') ? v.uuid : v;
        });
    }

    return Object.keys(vms);
}



/**
 * --- OpenOnErrorFileStream (originally from VM.js)
 *
 * OpenOnErrorFileStream is a bunyan stream that only creates the file when
 * there's an error or higher level message.  We use this for actions that
 * shouldn't log in the normal case but where we do want logs when something
 * breaks.  Thanks to Trent++ for most of this code.
 */

function OpenOnErrorFileStream(opts) {
    this.path = opts.path;
    this.level = bunyan.resolveLevel(opts.level);
    this.write = this.constructor.prototype.write1;
    this.end = this.constructor.prototype.end1;

    // Add the ringbuffer which we'll dump if we switch from not writing to
    // writing, and so that they'll show up in dumps.
    this.ringbuffer = new bunyan.RingBuffer({ limit: 50 });
    this.log_to_file = false;
}
util.inherits(OpenOnErrorFileStream, events.EventEmitter);

OpenOnErrorFileStream.prototype.startLoggingToFile = function () {
    this._startWriting(this.level);
};

OpenOnErrorFileStream.prototype._startWriting = function (level, rec) {
    var r;
    var self = this;

    if (this.stream) {
        return;
    }

    this.stream = fs.createWriteStream(this.path,
        { flags: 'a', encoding: 'utf8' });

    this.stream.once('close', function _onClose() {
        var args = Array.prototype.slice(arguments);
        args.unshift('close');
        self.emit.apply(self, args);
    });

    this.stream.once('drain', function _onDrain() {
        var args = Array.prototype.slice(arguments);
        args.unshift('drain');
        self.emit.apply(self, args);
    });

    this.end = function _end() { this.stream.end(); };
    this.write = this.constructor.prototype.write2;

    // Dump out logs from ringbuffer too since there was an error so we can
    // figure out what's going on.
    for (r in this.ringbuffer.records) {
        r = this.ringbuffer.records[r];
        if (r.level >= level && (!rec || r != rec)) {
            this.write(r);
        }
    }
};

OpenOnErrorFileStream.prototype.end1 = function () {
    // in initial mode we're not writing anything, so nothing to flush
    this.emit('close');
    return;
};

// Used until first ERROR or higher, then opens file and ensures future writes
// go to .write2().
OpenOnErrorFileStream.prototype.write1 = function (rec) {
    if (rec.level >= bunyan.ERROR || this.log_to_file) {
        this._startWriting(bunyan.TRACE, rec);
        return this.write(rec);
    } else {
        return this.ringbuffer.write(rec);
    }
};

// Used when writing to file.
OpenOnErrorFileStream.prototype.write2 = function (rec) {
    var str = JSON.stringify(rec, bunyan.safeCycles()) + '\n';
    this.stream.write(str);
};



// --- Exports

/**
 * Create a logger the way sdcadm likes it.
 */
function createLogger(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.name, 'opts.name');
    assert.string(opts.component, 'opts.component');
    assert.bool(opts.logToFile, 'opts.logToFile');
    assert.bool(opts.verbose, 'opts.verbose');
    assert.optionalString(opts.req_id, 'opts.req_id');

    // Log streams:
    // 1. Stream to stderr at WARN, at TRACE if `verbose`.
    var logStreams = [
        {
            stream: process.stderr,
            level: (opts.verbose ? 'trace' : 'warn')
        }
    ];

    // 2. Stream to a file if `logToFile` is true.
    var logFile = sprintf('%s/%s-%06d-%s.log',
        LOG_DIR, Date.now(0), process.pid, opts.component);
    if (opts.logToFile) {
        logStreams.push({
            level: 'trace',
            path: logFile
        });
    } else {
        logStreams.push({
            type: 'raw',
            stream: new OpenOnErrorFileStream({
                path: logFile,
                level: 'trace'
            }),
            level: 'trace'
        });
    }

    mkdirp.sync(LOG_DIR);

    return bunyan.createLogger({
        name: opts.name,
        component: opts.component,
        // https://github.com/mcavage/node-restify/pull/501 is fixed
        serializers: restify.bunyan.serializers,
        src: opts.verbose,
        streams: logStreams,
        req_id: opts.req_id || mod_uuid.v4()
    });
}



/**
 * Flush all open log streams
 */
function flushLogs(logs, callback) {
    if (!logs) {
        return callback();
    }

    var streams = [];
    if (!util.isArray(logs)) {
        logs = [ logs ];
    }

    if (logs.length === 0) {
        return callback();
    }

    logs.forEach(function (log) {
        if (!log || !log.streams || log.streams.length === 0) {
            return;
        }

        streams = streams.concat(log.streams);
    });

    var toClose = streams.length;
    var closed = 0;

    function _doneClose() {
        closed++;
        if (closed == toClose) {
            return callback();
        }
    }

    streams.forEach(function (str) {
        if (!str || !str.stream) {
            return _doneClose();
        }

        str.stream.once('drain', function () {
            _doneClose();
        });

        if (str.stream.write('')) {
            _doneClose();
        }
    });
}



module.exports = {
    createLogger: createLogger,
    flushLogs: flushLogs
};
