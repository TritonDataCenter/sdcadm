/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 *
 * `sdcadm service restore`
 */

var vasync = require('vasync');

var errors = require('../../errors');


function do_restore(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    cb(new errors.InternalError({
        message: 'sdcadm service restore is not yet implemented'
    }));
}

do_restore.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_restore.help = [
    'Restore Triton core services',
    '',
    'TODO: explain',
    '',
    'Usage:',
    '    {{name}} {{cmd}} [OPTIONS]',
    '',
    '{{options}}'
].join('\n');

module.exports = do_restore;
