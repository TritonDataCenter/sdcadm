/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */
var errors = require('../errors');
var tabula = require('tabula');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * The 'sdcadm history' CLI subcommand.
 */

function do_history(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (args.length === 1) {
        var id = args[0];
        if (!UUID_RE.test(id)) {
            return cb(new errors.UsageError('Invalid UUID: ' + id));
        }
        return self.sdcadm.history.getHistory(id, function (err, hist) {
            if (err) {
                return cb(err);
            }
            console.log(JSON.stringify(hist, null, 4));
            return cb();
        });
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);
    var options = {};

    if (opts.since) {
        try {
            options.since = new Date(opts.since.trim()).toISOString();
        } catch (e) {
            return cb(new errors.UsageError('Invalid Date: ' +
                        opts.since.trim()));
        }
    }

    if (opts.until) {
        try {
            options.until = new Date(opts.until.trim()).toISOString();
        } catch (e1) {
            return cb(new errors.UsageError('Invalid Date: ' +
                        opts.until.trim()));
        }
    }

    return self.sdcadm.history.listHistory(options, function (err, history) {
        if (err) {
            return cb(err);
        }

        if (opts.json) {
            console.log(JSON.stringify(history, null, 4));
        } else {
            var validFieldsMap = {};
            if (!history.length) {
                return cb();
            }
            var rows = history.map(function (hst) {
                var chgs;
                // Only set changes value when it's in a known format:
                if (hst.changes && Array.isArray(hst.changes)) {
                    chgs = hst.changes.map(function (c) {
                        if (!c.type || !c.service) {
                            return ('');
                        }
                        return (c.type + '(' + c.service.name + ')');
                    }).join(',');
                }
                var row = {
                    uuid: hst.uuid,
                    changes: chgs,
                    started: (hst.started ?
                        new Date(hst.started).toJSON() : null),
                    finished: (hst.finished ?
                        new Date(hst.finished).toJSON() : null),
                    error: (hst.error ?
                        (hst.error.message ?
                         hst.error.message.split('\n', 1)[0] :
                         hst.error) : null),
                    user: hst.username ? hst.username : null
                };

                if (row.changes.length > 40) {
                    row.changes = row.changes.substring(0, 40) + '...';
                }

                if (row.error && row.error.length > 40) {
                    row.error = row.error.substring(0, 40) + '...';
                }

                return row;
            });
            rows.forEach(function (v) {
                for (var k in v) {
                    validFieldsMap[k] = true;
                }
            });
            tabula(rows, {
                skipHeader: opts.H,
                columns: columns,
                sort: sort,
                validFields: Object.keys(validFieldsMap)
            });
        }
        return cb();
    });
}

do_history.help = (
    'History of sdcadm commands.\n' +
    '\n' +
    'The historical collection of sdcadm commands ran into the current\n' +
    'SDC setup, searchable by execution time (when SAPI is available).\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} history [<options>] [HISTORY-ITEM-UUID]\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'When HISTORY-ITEM-UUID is given, only that history item will\n' +
    'be included using JSON format and all the other options will\n' +
    'be ignored'
);

do_history.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show history as JSON.'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'uuid,user,started,finished,changes,error',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-started,finished',
        help: 'Sort on the given fields. Default is "-started,finished".',
        helpArg: 'field1,...'
    },
    {
        names: ['since'],
        type: 'string',
        help: 'Return only values since the given date. ISO 8601 Date String.'
    },
    {
        names: ['until'],
        type: 'string',
        help: 'Return only values until the given date. ISO 8601 Date String.'
    }
];

do_history.logToFile = false;

// --- exports

module.exports = {
    do_history: do_history
};
