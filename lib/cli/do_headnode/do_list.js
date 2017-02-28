/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 *
 * `sdcadm headnode list`
 */

var tabula = require('tabula');
var vasync = require('vasync');

var common = require('../../common');
var errors = require('../../errors');


function do_list(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    var cnapi = self.sdcadm.cnapi;

    vasync.pipeline({arg: {}, funcs: [
        function getThem(ctx, next) {
            cnapi.listServers({
                headnode: true,
                extras: 'sysinfo'
            }, function (err, hns) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.hns = hns;
                next();
            });
        },
        function showThem(ctx, next) {
            tabula.sortArrayOfObjects(ctx.hns, opts.s);

            if (opts.json) {
                common.jsonStream(ctx.hns);
            } else {
                ctx.hns.forEach(function (hn) {
                    hn.admin_ip = common.serverAdminIpFromSysinfo(hn.sysinfo);
                });
                tabula(ctx.hns, {
                    skipHeader: opts.H,
                    columns: opts.o
                });
            }
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
        default: 'hostname,uuid,status,admin_ip'.split(','),
        help: 'Specify fields (columns) to output.',
        helpArg: 'field,...'
    },
    {
        names: ['s'],
        type: 'arrayOfCommaSepString',
        default: ['alias'],
        help: 'Sort on the given fields.',
        helpArg: 'field,...'
    },
];

do_list.aliases = ['ls'];

do_list.help = [
    'List all headnodes',
    '',
    'Usage:',
    '    {{name}} {{cmd}} [OPTIONS]',
    '',
    '{{options}}'
].join('\n');


// --- exports

module.exports = do_list;
