/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */
/*
 * This file includes both, the `sdcadm history` command and the functions
 * required for history CRUD. Among others, this file is in charge of handling
 * SAPI (un)availability when trying to save an item into history in a way
 * that it should completely hide that to anything using the create/update
 * history methods.
 *
 */

var fs = require('fs');
var path = require('path');

var mkdirp = require('mkdirp');
var assert = require('assert-plus');
var uuid = require('node-uuid');
var vasync = require('vasync');

var common = require('./common');
var errors = require('./errors');

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;


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
            cb(new errors.InternalError({
                message: 'error creating history work dir: ' + self.wrkDir,
                cause: err
            }));
            return;
        }
        cb();
        return;
    });
};


/*
 * Save history item to a file (mostly used to be able to deal with SAPI
 * downtimes). When an attempt to save a bogus history item is made, the
 * file will not be saved.
 */
History.prototype._saveToFile = function _saveToFile(fname, history, cb) {
    assert.object(history, 'history');

    var self = this;

    var s;
    try {
        s = JSON.stringify(history, common.safeCycles());
    } catch (e) {
        self.sdcadm.log.error({
            err: e,
            history: history
        }, 'Error saving history to file');
        cb(null);
        return;
    }

    fs.writeFile(fname, s, {encoding: 'utf8'}, cb);
};

/*
 * Attempt to read history from the file given by `fname`
 *
 * In case of validation error when reading from that file, the file will
 * be removed so no future attempts or re-reading it will be made.
 */
History.prototype._readFromFile = function _readFromFile(fname, cb) {
    var self = this;

    fs.readFile(fname, {
        encoding: 'utf8'
    }, function (err, data) {
        if (err) {
            cb(err);
            return;
        }
        var history;
        try {
            history = JSON.parse(data);
        } catch (e) {
            self.sdcadm.log.error({err: e}, 'Error reading history from file');
            cb(e);
            return;
        }

        self._validateItem(history, function (err2) {
            if (err2) {
                self.sdcadm.log.error({err: err2}, 'Invalid history item');
                fs.unlink(fname, function (fErr) {
                    if (fErr) {
                        self.sdcadm.log.error({
                            err: fErr
                        }, 'Error removing invalid history file');
                    }
                    cb(err2);
                });
            } else {
                cb(null, history);
            }
        });

    });
};


/*
 * Ensure that whatever we are trying to read from or save to a History file
 * contains only the expected history properties.
 */
History.prototype._validateItem = function _validateItem(history, cb) {


    if (!history || typeof (history) !== 'object') {
        cb(new errors.ValidationError('history must be an object'));
        return;
    }

    if (!history.changes || typeof (history.changes) !== 'object') {
        cb(new errors.ValidationError('history.changes must be an object'));
        return;
    }

    if (history.username) {
        if (typeof (history.username) !== 'string') {
            cb(new errors.ValidationError(
                'history.username must be a string'));
            return;
        }
    }

    if (history.uuid) {
        if (typeof (history.uuid) !== 'string') {
            cb(new errors.ValidationError('history.uuid must be a string'));
            return;
        }
        if (!UUID_RE.test(history.uuid)) {
            cb(new errors.ValidationError('history.uuid is not a valid UUID'));
            return;
        }
    }

    if (history.started) {
        var d  = new Date(history.started);
        if (d.toJSON() === null) {
            cb(new errors.ValidationError(
                'history.started is not a valid date'));
            return;
        }
    }

    if (history.finished) {
        var f  = new Date(history.finished);
        if (f.toJSON() === null) {
            cb(new errors.ValidationError(
                'history.finished is not a valid date'));
            return;
        }
    }

    cb(null);
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
            self.sdcadm.log.error({err: new errors.ValidationError({
                message: 'error validating history UUID',
                cause: history.uuid + ' is not a valid UUID'
            })});
            cb();
            return;
        }
    } else {
        history.uuid = uuid();
    }

    if (history.started) {
        var d  = new Date(history.started);
        if (d.toJSON() === null) {
            self.sdcadm.log.error({err: new errors.ValidationError({
                message: 'error validating history start time',
                cause: history.started + ' is not a valid date'
            })});
            cb();
            return;
        }
        history.started = d.getTime();
    } else {
        history.started = new Date().getTime();
    }

    // Try to use SAPI first, on error of any type, save history to file:
    self.sdcadm.sapi.addHistory(history, function (err, hist) {
        if (err) {
            self.sdcadm.log.info({
                err: err
            }, 'Error saving history to SAPI, saving to local file');

            var fname = path.join(self.wrkDir, history.uuid + '.json');
            self._saveToFile(fname, history, function (err2) {
                if (err2) {
                    self.sdcadm.log.error({err: new errors.InternalError({
                        message: 'error saving file: ' + fname,
                        cause: err2
                    })});
                    cb();
                    return;
                }
                cb(null, history);
                return;
            });
        }

        self.sdcadm.log.debug({
            history: hist
        }, 'History saved to SAPI');

        cb(null, history);
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
            self.sdcadm.log.error({err: new errors.ValidationError({
                message: 'error validating history finish time',
                cause: history.finished + ' is not a valid date'
            })});
            cb();
            return;
        }
        history.finished = d.getTime();
    } else {
        history.finished = new Date().getTime();
    }

    // Try to use SAPI first, on error of any type, save history to file:
    self.sdcadm.sapi.updateHistory(history.uuid, history, function (err, hist) {
        if (err) {
            self.sdcadm.log.info({
                err: err
            }, 'Error saving history to SAPI, saving to local file');

            var fname = path.join(self.wrkDir, history.uuid + '.json');

            self._readFromFile(fname, function (err2, hist2) {
                if (err2) {
                    self.sdcadm.log.info({
                        err: err2
                    }, 'error reading file: ' + fname);
                    // If there wasn't a previous file, let's just go with what
                    // we have in memory and finish the record:
                    hist2 = history;
                } else {
                    // Override anything already saved with the new values:
                    Object.keys(history).forEach(function (k) {
                        hist2[k] = history[k];
                    });
                }

                self._saveToFile(fname, hist2, function (err3) {
                    if (err3) {
                        self.sdcadm.log.error({err: new errors.InternalError({
                            message: 'error saving file: ' + fname,
                            cause: err3
                        })});
                        cb();
                        return;
                    }
                    cb(null, hist2);
                    return;
                });
            });
        }

        // On success SAPI update, check if is there any pending history file
        // from previous invocations and we need to catch up:
        self.catchUp(function (err4) {
            if (err4) {
                self.sdcadm.log.info({
                    err: err4
                }, 'Error adding history to SAPI. Saved to local files.');
            }
            cb(null, hist);
        });
    });
};


History.prototype.getHistory = function (id, cb) {
    var self = this;

    // Try to use SAPI first, on error of any type, try to read from file:
    self.sdcadm.sapi.getHistory(id, function (err2, hist2) {
        if (err2) {
            self.sdcadm.log.info({
                err: err2
            }, 'Error reading history from SAPI, trying local files');

            var fname = path.join(self.wrkDir, id + '.json');
            self._readFromFile(fname, function (err, hist) {
                if (err) {
                    cb(new errors.InternalError({
                        message: 'error reading file: ' + fname,
                        cause: err
                    }));
                    return;
                }
                cb(null, hist);
                return;
            });
        }

        cb(null, hist2);
        return;
    });

};

History.prototype.listHistory = function (opts, cb) {
    var self = this;

    self.sdcadm.sapi.listHistory(opts, function (err, history) {
        if (err) {
            // Only when the error is not an options error, try reading from
            // file
            self._readHistoryDir(function (files) {
                history = [];
                vasync.forEachPipeline({
                    inputs: files,
                    func: function _readHistoryFile(item, next) {
                        var f = path.join(self.wrkDir, item);
                        self._readFromFile(f, function (err3, hist) {
                            if (err3) {
                                next(err3);
                                return;
                            }
                            history.push(hist);
                            next();
                        });
                    }
                }, function (err2, results) {
                    if (err2) {
                        cb(new errors.InternalError({
                            message: 'error reading directory: ' + self.wrkDir,
                            cause: err2
                        }));
                        return;
                    }
                    cb(null, history);
                    return;
                });
            });

        } else {
            cb(null, history);
            return;
        }
    });
};


History.prototype.catchUp = function (cb) {
    var self = this;

    self._readHistoryDir(function (files) {
        if (files.length) {
            vasync.forEachPipeline({
                inputs: files,
                func: function _postHistoryToSAPI(item, next) {
                    var f = path.join(self.wrkDir, item);
                    self._readFromFile(f, function (er, data) {
                        if (er) {
                            next(er);
                            return;
                        }

                        // Avoid raising an error b/c no file contents:
                        if (!data) {
                            next();
                            return;
                        }

                        self._getOrCreateOnSAPI(data, function (er2, h) {
                            if (er2) {
                                self.sdcadm.log.info({
                                    err: er2
                                }, 'Error saving history from ' +
                                    'local file to SAPI');
                            }
                            fs.unlink(f, function (er3) {
                                if (er3) {
                                    self.sdcadm.log.info({
                                        err: er3
                                    }, 'Error removing file: %s', f);
                                }
                                next();
                                return;
                            });
                        });

                    });
                }
            }, function catchUpPipeline(err, results) {
                if (err) {
                    self.sdcadm.log.error({
                        err: err
                    }, 'error saving history to SAPI');
                }
                cb(null);
            });
        } else {
            cb(null);
        }
    });

};

History.prototype._readHistoryDir = function (cb) {
    var self = this;

    fs.readdir(self.wrkDir, function (err, files) {
        if (err) {
            cb(new errors.InternalError({
                message: 'error reading directory: ' + self.wrkDir,
                cause: err
            }));
            return;
        }
        cb(files);
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
            if (!history.started) {
                history.started = new Date().getTime();
            }
            self.sdcadm.sapi.addHistory(history, function (err, hist) {
                if (err) {
                    self.sdcadm.log.info({
                        err: err
                    }, 'Error saving history to SAPI');
                    cb(err);
                    return;
                }
                cb(null, hist);
                return;
            });
        } else {
            cb(null, hist2);
            return;
        }
    });
};

// --- exports

module.exports = {
    History: History
};
// vim: set softtabstop=4 shiftwidth=4:
