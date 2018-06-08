/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var tabula = require('tabula');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');


// --- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * The 'sdcadm check-health (health)' CLI subcommand.
 */


function do_check_health(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], callback);
        return;
    }

    var healthOpts = {};
    var typeArgs = [];
    var validTypes = ['vm', 'agent'];

    if (opts.type) {
        healthOpts.type = opts.type;
    }

    if (opts.servers) {
        healthOpts.servers = opts.servers;
    }

    if (args.length) {
        args = args.filter(function (arg) {
            if (arg.indexOf('=') !== -1) {
                typeArgs.push(arg);
                return false;
            }
            return true;
        });
    }

    if (typeArgs.length) {
        healthOpts.type = [];
        typeArgs.forEach(function (arg) {
            var parts = arg.split('=');

            if (parts[0] !== 'type') {
                callback(new errors.UsageError(
                    'invalid argument: ' + arg));
                return;
            }

            if (validTypes.indexOf(parts[1]) === -1) {
                callback(new errors.UsageError(
                    'invalid instance type: ' + parts[1]));
                return;
            }

            healthOpts.type.push(parts[1]);
        });

        // If we have both types, just ignore them, since everything
        // will be included;
        if (healthOpts.type.length > 1) {
            delete healthOpts.type;
        } else {
            healthOpts.type = healthOpts.type[0];
        }
    }


    var names = {};
    var uuids = [];

    args.forEach(function (arg) {
        if (arg.match(UUID_RE)) {
            uuids.push(arg);
        } else {
            names[arg] = true;
        }
    });

    function replaceNamesWithUuids(funcName, cb) {
        if (Object.keys(names).length === 0) {
            cb();
            return;
        }
        self.sdcadm[funcName]({}, function (err, objs) {
            if (err) {
                cb(err);
                return;
            }

            objs.forEach(function (obj) {
                if (names[obj.name] && obj.uuid) {
                    uuids.push(obj.uuid);
                    delete names[obj.name];
                } else if (names[obj.alias] && obj.instance) {
                    uuids.push(obj.instance);
                    delete names[obj.alias];
                }
            });

            cb();
        });
    }

    function displayResults(err, statuses) {
        if (err) {
            callback(new errors.InternalError(err));
            return;
        }

        var rows = statuses.map(function (status) {
            var obj = {
                type: status.type,
                instance: status.instance,
                alias: status.alias,
                service: status.service,
                hostname: status.hostname,
                healthy: status.healthy
            };

            if (status.health_errors) {
                obj.health_errors = status.health_errors;
            }

            return obj;
        });


        var errRows = rows.filter(function (row) {
            return row.health_errors;
        });

        var sortAttr = ['-type', 'service', 'hostname', 'instance'];
        common.sortArrayOfObjects(rows, sortAttr);

        if (opts.json) {
            if (opts.quiet) {
                console.log(JSON.stringify(errRows, null, 4));
            } else {
                console.log(JSON.stringify(rows, null, 4));
            }
        } else {
            if (!opts.quiet) {
                var columns = ['instance', 'service', 'hostname', 'alias',
                               'healthy'];

                tabula(rows, {
                    skipHeader: opts.H,
                    columns: columns
                });
            }

            errRows.forEach(function (row) {
                row.health_errors.forEach(function (errObj) {
                    console.error((row.instance || row.service),
                            errObj.message);
                });
            });
        }

        if (!opts.json && !opts.quiet && errRows.length > 0) {
            callback(new Error('Some instances appear unhealthy'));
            return;
        }

        callback();
        return;
    }


    if (args.length === 0) {
        self.sdcadm.checkHealth(healthOpts, displayResults);
        return;
    }


    vasync.pipeline({ funcs: [
        function getSvcs(_, next) {
            replaceNamesWithUuids('getServices', next);
        },
        function getInsts(_, next) {
            replaceNamesWithUuids('listInsts', next);
        }
    ]}, function (err) {
        if (err) {
            return callback(new errors.InternalError(err));
        }

        if (Object.keys(names).length > 0) {
            var msg = 'unrecognized service or instance: ' +
                Object.keys(names).join(', ');
            return callback(new errors.UsageError(msg));
        }

        return self.sdcadm.checkHealth({ uuids: uuids }, displayResults);
    });
}

do_check_health.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output'
    },
    {
        names: ['quiet', 'q'],
        type: 'bool',
        help: 'Only print health errors, if any'
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfString',
        help: 'The UUID or hostname of the CNs to limit the check to.' +
            ' One argument per server is required: -s UUID1 -s UUID2 ...'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    }
];
do_check_health.aliases = ['health'];
do_check_health.help = (
    'Check that services or instances are up.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} check-health [<options>] [<svc or inst>...]\n' +
    '\n' +
    '{{options}}' +
    'Instances to be checked can be filtered via <filter> by type:\n' +
    '    type=vm\n' +
    '    type=agent\n' +
    'and service or instance name:\n' +
    '    imgapi\n' +
    '    cnapi cn-agent\n'

);
do_check_health.logToFile = false;

// --- exports
module.exports = {
    do_check_health: do_check_health
};
