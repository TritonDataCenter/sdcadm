/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var errors = require('../errors');

/*
 * The 'sdcadm check-config' CLI subcommand.
 */

function do_check_config(subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    this.sdcadm.checkConfig({}, function (err, errs) {
        if (err) {
            callback(err);
        } else {
            if (errs && errs.length) {
                errs.forEach(function (er) {
                    console.error(er);
                });
                callback();
            } else {
                console.info('All good!');
                callback();
            }
        }
    });
}
do_check_config.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_check_config.help = (
    'Check sdc config in SAPI versus system reality.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} check-config [<options>]\n' +
    '\n' +
    '{{options}}'
);
do_check_config.logToFile = false;

// --- exports

module.exports = {
    do_check_config: do_check_config
};
