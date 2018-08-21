/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var errors = require('../errors');

/*
 * The 'sdcadm services (svcs)' CLI subcommand.
 */

function do_info(subcmd, opts, args, callback) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        callback(new errors.UsageError('too many args: ' + args));
        return;
    }

    var cfg = self.sdcadm.config;

    if (opts.json) {
        console.log(JSON.stringify(cfg, null, 2));
        callback();
        return;
    }

    console.log('Datacenter Company Name: %s',
        cfg.datacenter_company_name);
    console.log('Datacenter Name: %s',
        cfg.datacenter_name);
    console.log('Datacenter Location: %s',
        cfg.datacenter_location);

    console.log();

    console.log('Admin IP: %s',
        cfg.admin_ip);
    console.log('External IP: %s',
        cfg.external_ip);
    console.log('DNS Domain: %s',
        cfg.dns_domain);

    callback();
}
do_info.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output'
    }
];
do_info.aliases = ['config'];
do_info.help = (
    'Get SDC info.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} info [<options>]\n'
    + '\n'
    + '{{options}}'
);

// --- exports

module.exports = {
    do_info: do_info
};
