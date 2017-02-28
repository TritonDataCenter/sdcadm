/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 *
 * `sdcadm headnode takeover`
 */

var vasync = require('vasync');

var errors = require('../../errors');


function do_takeover(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    cb(new errors.InternalError({
        message: 'sdcadm headnode takeover is not yet implemented'
    }));
}

do_takeover.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_takeover.help = [
    'Takeover as primary headnode',
    '',
    'This command can be run on a secondary headnode to takeover as the',
    'primary headnode from a healthy, running primary headnode. This can be',
    'used to decommission a current headnode server.',
    '',
    '*Most* service instances will be moved from the current primary to this',
    'headnode, attempting to minimize service disruption. If there are ',
    'pre-existing instances of HA services (e.g. manatee, moray, binder) on',
    'this server, this command will *not* create two instances on the same',
    'server.',
    '',
    'After successful completion, the operator will have to deal possibly',
    'remaining HA services instances (e.g. manatee) before decommissioning',
    'the server. It is expected that soon after a replacement headnode and',
    'instances of HA services will be added, to return the DC to the suggested',
    'resiliency setup.',
    '',
    'Usage:',
    '    {{name}} {{cmd}} [OPTIONS]',
    '',
    '{{options}}'
].join('\n');

module.exports = do_takeover;
