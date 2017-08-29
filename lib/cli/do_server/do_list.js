/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 *
 * `sdcadm server list`
 */

var tabula = require('tabula');
var vasync = require('vasync');

var common = require('../../common');
var errors = require('../../errors');


var DEFAULT_COLUMNS = [
    'hostname',
    'uuid',
    'status',
    'flags',
    {
        lookup: 'admin_ip',
        name: 'ADMIN IP'
    },
];
var DEFAULT_LONG_COLUMNS = DEFAULT_COLUMNS.concat([
    {
        lookup: 'current_platform',
        name: 'CURR PLATFORM'
    },
    {
        lookup: 'uptime',
        align: 'right'
    },
    {
        lookup: 'ram',
        align: 'right'
    },
    'traits'
]);

var DEFAULT_SORT = ['-headnode', 'hostname'];


function do_list(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    var cnapi = self.sdcadm.cnapi;
    var tableSort = opts.s || DEFAULT_SORT;
    var tableColumns = opts.o
        || (opts.long ? DEFAULT_LONG_COLUMNS : DEFAULT_COLUMNS);

    vasync.pipeline({arg: {}, funcs: [
        function getThem(ctx, next) {
            cnapi.listServers({
                extras: 'all'
            }, function (err, servers) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.servers = servers;
                next();
            });
        },
        function showThem(ctx, next) {
            tabula.sortArrayOfObjects(ctx.servers, tableSort);

            if (opts.json) {
                common.jsonStream(ctx.servers);
            } else {
                var now = new Date();
                ctx.servers.forEach(function (s) {
                    s.admin_ip = common.serverAdminIpFromSysinfo(s.sysinfo);

                    var flags = [];
                    if (s.setup) { flags.push('S'); }
                    if (s.headnode) { flags.push('H'); }
                    if (s.reserved) { flags.push('R'); }
                    if (s.current_platform !== s.boot_platform) {
                        flags.push('B');
                    }
                    s.flags = flags.join('');

                    s.uptime = null;
                    if (s.last_boot && s.status === 'running') {
                        var bootTime = new Date(s.last_boot);
                        if (!isNaN(bootTime.getTime())) {
                            s.uptime = common.longAgo(bootTime, now);
                        }
                    }
                });
                tabula(ctx.servers, {
                    skipHeader: opts.H,
                    columns: tableColumns
                });
            }
            next();
        }
    ]}, callback);
}

do_list.options = [
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
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'arrayOfCommaSepString',
        help: 'Specify comma-separated field names (columns) to output.',
        helpArg: 'FIELD,...'
    },
    {
        names: ['long', 'l'],
        type: 'bool',
        help: 'Long/wider output. Ignored if "-o ..." is used.'
    },
    {
        names: ['s'],
        type: 'arrayOfCommaSepString',
        help: 'Sort on the given comma-separated field names. Prefix with '
            + '"-" for a reverse sort. Default: "'
            + DEFAULT_SORT.join(',') + '"',
        helpArg: 'FIELD,...'
    },
];

do_list.aliases = ['ls'];

do_list.help = [
    'List servers in this datacenter.',
    '',
    'Usage:',
    '    {{name}} {{cmd}} [OPTIONS]',
    '',
    '{{options}}',
    'Fields: Most fields are the key names from the raw JSON objects (see',
    '`{{name}} {{cmd}} -j`). Some special fields:',
    '    admin_ip   The IP of the server global zone on the "admin" network',
    '    flags      A set of single letter flags summarizing some fields:',
    '               "S" setup, "H" headnode, "R" reserved, "B" boot platform',
    '               differs from current platform',
    '    uptime     An approximate uptime for running servers.'
].join('\n');


// --- exports

module.exports = do_list;
