/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */
/*
 * This file includes both, the `sdcadm history` command and the functions
 * required for history CRUD. Among others, this file is in charge of handling
 * SAPI (un)availability when trying to save an item into history in a way
 * that it should completely hide that to anything using the create/update
 * history methods.
 *
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
var common = require('./common');

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
    this.sdcadm = opts.sdcadm;
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
    if (!history.uuid && self.sdcadm.uuid) {
        history.uuid = self.sdcadm.uuid;
    }

    if (!history.username && self.sdcadm.username) {
        history.username = self.sdcadm.username;
    }

    if (history.username) {
        assert.string(history.username, 'history.username');
    }

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

    // Try to use SAPI first, on error of any type, save history to file:
    self.sdcadm.sapi.addHistory(history, function (err, hist) {
        if (err) {
            self.sdcadm.log.error({
                err: err
            }, 'Error saving history to SAPI');

            var fname = path.join(self.wrkDir, history.uuid + '.json');
            return saveHistoryToFile(fname, history, function (err2) {
                if (err2) {
                    return cb(new errors.InternalError({
                        message: 'error saving file: ' + fname,
                        cause: err2
                    }));
                }
                return cb(null, history);
            });
        }

        self.sdcadm.log.debug({
            history: hist
        }, 'History saved to SAPI');

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
    if (!history.uuid && self.sdcadm.uuid) {
        history.uuid = self.sdcadm.uuid;
    }
    assert.string(history.uuid, 'history.uuid');

    if (!history.username && self.sdcadm.username) {
        history.username = self.sdcadm.username;
    }

    if (history.username) {
        assert.string(history.username, 'history.username');
    }

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

    // Try to use SAPI first, on error of any type, save history to file:
    self.sdcadm.sapi.updateHistory(history.uuid, history, function (err, hist) {
        if (err) {
            self.sdcadm.log.error({
                err: err
            }, 'Error saving history to SAPI');

            var fname = path.join(self.wrkDir, history.uuid + '.json');

            return readHistoryFromFile(fname, function (err2, hist2) {
                if (err2) {
                    self.sdcadm.log.error({
                        err: err2
                    }, 'error reading file: ' + fname);
                } else {
                    // Override anything already saved with the new values:
                    Object.keys(history).forEach(function (k) {
                        hist2[k] = history[k];
                    });
                }

                return saveHistoryToFile(fname, hist, function (err3) {
                    if (err3) {
                        return cb(new errors.InternalError({
                            message: 'error saving file: ' + fname,
                            cause: err3
                        }));
                    }
                    return cb(null, hist2);
                });
            });
        }

        // On success SAPI update, check if is there any pending history file
        // from previous invocations and we need to catch up:
        return self.catchUp(function (err4) {
            if (err4) {
                self.sdcadm.log.error({
                    err: err4
                }, 'Error adding history to SAPI');
                return cb(err4, hist);
            }
            return cb(null, hist);
        });
    });
};


History.prototype.getHistory = function (id, cb) {
    var self = this;

    // Try to use SAPI first, on error of any type, try to read from file:
    self.sdcadm.sapi.getHistory(id, function (err2, hist2) {
        if (err2) {
            self.sdcadm.log.error({
                err: err2
            }, 'Error reading history from SAPI');

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
        }

        return cb(null, hist2);
    });

};

History.prototype.listHistory = function (opts, cb) {
    var self = this;

    return self.sdcadm.sapi.listHistory(opts, function (err, history) {
        if (err) {
            // Only when the error is not an options error, try reading from
            // file
            return self._readHistoryDir(function (files) {
                history = [];
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

        } else {
            return cb(null, history);
        }
    });
};


History.prototype.catchUp = function (cb) {
    var self = this;

    return self._readHistoryDir(function (files) {
        if (files.length) {
            vasync.forEachPipeline({
                inputs: files,
                func: function _postHistoryToSAPI(item, next) {
                    var f = path.join(self.wrkDir, item);
                    readHistoryFromFile(f, function (er, data) {
                        if (er) {
                            return next(er);
                        }

                        // Avoid raising an error b/c no file contents:
                        if (!data) {
                            return next();
                        }

                        return self._getOrCreateOnSAPI(data,
                            function (er2, h) {
                            if (er2) {
                                self.sdcadm.log.error({
                                    err: er2
                                }, 'Error saving history to SAPI');
                            }
                            fs.unlink(f, function (er3) {
                                if (er3) {
                                    self.sdcadm.log.error({
                                        err: er3
                                    }, 'Error removing file: %s', f);
                                }
                                next();
                            });
                        });

                    });
                }
            }, function catchUpPipeline(err, results) {
                if (err) {
                    return cb(new errors.InternalError({
                        message: 'error saving history to SAPI',
                        cause: err
                    }));
                }
                return cb(null);
            });
        } else {
            return cb(null);
        }
    });

};

History.prototype._readHistoryDir = function (cb) {
    var self = this;

    return fs.readdir(self.wrkDir, function (err, files) {
        if (err) {
            return cb(new errors.InternalError({
                message: 'error reading directory: ' + self.wrkDir,
                cause: err
            }));
        }
        return cb(files);
    });
};


History.prototype._getOrCreateOnSAPI = function (history, cb) {
    var self = this;
    assert.object(history, 'history');

    if (!history.uuid && self.sdcadm.uuid) {
        history.uuid = self.sdcadm.uuid;
    }

    self.sdcadm.sapi.getHistory(history.uuid, function (err2, hist2) {
        if (err2) {
            self.sdcadm.sapi.addHistory(history, function (err, hist) {
                if (err) {
                    self.sdcadm.log.error({
                        err: err
                    }, 'Error saving history to SAPI');
                    return cb(err);
                }
                return cb(null, hist);
            });
        } else {
            return cb(null, hist2);
        }
    });
};

// --- exports

module.exports = {
    History: History
};
// vim: set softtabstop=4 shiftwidth=4:
