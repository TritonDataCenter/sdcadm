/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */
/*
 * This file includes both, the `sdcadm history` command and the functions
 * required for history CRUD. Among others, this file is in charge of handling
 * SAPI (un)availability when trying to save an item into history in a way
 * that it should completely hide that to anything using the create/update
 * history methods.
 *
 * TODO: Right now, we're just creating JSON files for history at
 * /var/sdcadm/history. Need to add the functions to CRUD this stuff into SAPI.
 */

var util = require('util'),
    format = util.format;
var fs = require('fs');
var path = require('path');

var mkdirp = require('mkdirp');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var assert = require('assert-plus');
var uuid = require('node-uuid');
var vasync = require('vasync');
var tabula = require('tabula');

var errors = require('./errors');

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;


function saveHistoryToFile(fname, history, cb) {
    fs.writeFile(fname, JSON.stringify(history), {
        encoding: 'utf8'
    }, function (err) {
        if (err) {
            return cb(err);
        }
        return cb(null);
    });
}

function readHistoryFromFile(fname, cb) {
    fs.readFile(fname, {
        encoding: 'utf8'
    }, function (err, data) {
        if (err) {
            return cb(err);
        }
        return cb(null, JSON.parse(data));
    });
}

// --- History Class
function History(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
}

History.prototype.init = function (cb) {
    var self = this;

    // It will not hurt to make sure the history dir exists:
    self.wrkDir = '/var/sdcadm/history';
    mkdirp(self.wrkDir, function (err) {
        if (err) {
            return cb(new errors.InternalError({
                message: 'error creating work dir: ' + self.wrkDir,
                cause: err
            }));
        }
        return cb();
    });
};

/*
 * Expects an object with, at least, a `changes` member. `started` and `uuid`
 * members will be added to the object when not present. Note that `uuid` must
 * be a valid UUID and `started` must be a valid Date representation accepted
 * by JavaScript's `new Date()` constructor.
 */
History.prototype.saveHistory = function (history, cb) {
    var self = this;

    assert.object(history, 'history');
    assert.object(history.changes, 'history.changes');
    if (history.uuid) {
        assert.string(history.uuid, 'history.uuid');
        if (!UUID_RE.test(history.uuid)) {
            return cb(new errors.ValidationError({
                message: 'error validating history UUID',
                cause: history.uuid + ' is not a valid UUID'
            }));
        }
    } else {
        history.uuid = uuid();
    }

    if (history.started) {
        var d  = new Date(history.started);
        if (d.toJSON() === null) {
            return cb(new errors.ValidationError({
                message: 'error validating history start time',
                cause: history.started + ' is not a valid date'
            }));
        }
        history.started = d.getTime();
    } else {
        history.started = new Date().getTime();
    }

    var fname = path.join(self.wrkDir, history.uuid + '.json');
    return saveHistoryToFile(fname, history, function (err) {
        if (err) {
            return cb(new errors.InternalError({
                message: 'error saving file: ' + fname,
                cause: err
            }));
        }
        return cb(null, history);
    });
};

/*
 * Updates history object with the given `uuid` member, which is mandatory for
 * updates. If the `changes` member is provided, it'll be overriden from the
 * one created by `saveHistory`. A `finished` member will be added when not
 * present. Note that `finished` must be a valid Date representation accepted
 * by JavaScript's `new Date()` constructor.
 */
History.prototype.updateHistory = function (history, cb) {
    var self = this;

    assert.object(history, 'history');
    assert.string(history.uuid, 'history.uuid');
    if (history.changes) {
        assert.object(history.changes, 'history.changes');
    }
    if (history.finished) {
        var d  = new Date(history.finished);
        if (d.toJSON() === null) {
            return cb(new errors.ValidationError({
                message: 'error validating history finish time',
                cause: history.finished + ' is not a valid date'
            }));
        }
        history.finished = d.getTime();
    } else {
        history.finished = new Date().getTime();
    }


    var fname = path.join(self.wrkDir, history.uuid + '.json');

    return readHistoryFromFile(fname, function (err, hist) {
        if (err) {
            return cb(new errors.InternalError({
                message: 'error reading file: ' + fname,
                cause: err
            }));
        }

        // Override anything already saved with the new values:
        Object.keys(history).forEach(function (k) {
            hist[k] = history[k];
        });

        return saveHistoryToFile(fname, hist, function (err2) {
            if (err2) {
                return cb(new errors.InternalError({
                    message: 'error saving file: ' + fname,
                    cause: err2
                }));
            }
            return cb(null, hist);
        });
    });
};


History.prototype.getHistory = function (id, cb) {
    var self = this;

    var fname = path.join(self.wrkDir, id + '.json');
    return readHistoryFromFile(fname, function (err, hist) {
        if (err) {
            return cb(new errors.InternalError({
                message: 'error reading file: ' + fname,
                cause: err
            }));
        }
        return cb(null, hist);
    });
};

/*
 * TODO: Add options: created, search interval ...
 * For now, it just return every history item.
 */
History.prototype.listHistory = function (opts, cb) {
    var self = this;

    return fs.readdir(self.wrkDir, function (err, files) {
        if (err) {
            return cb(new errors.InternalError({
                message: 'error reading directory: ' + self.wrkDir,
                cause: err
            }));
        }
        var history = [];
        vasync.forEachPipeline({
            inputs: files,
            func: function _readHistoryFile(item, next) {
                var f = path.join(self.wrkDir, item);
                return readHistoryFromFile(f, function (err3, hist) {
                    if (err3) {
                        return next(err3);
                    }
                    history.push(hist);
                    next();
                });
            }
        }, function (err2, results) {
            if (err2) {
                return cb(new errors.InternalError({
                    message: 'error reading directory: ' + self.wrkDir,
                    cause: err2
                }));
            }
            return cb(null, history);
        });
    });
};

// --- exports

module.exports = {
    History: History
};
// vim: set softtabstop=4 shiftwidth=4:
