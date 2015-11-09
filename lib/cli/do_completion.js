/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2015 Joyent, Inc.
 *
 * `sdcadm completion`
 */

function do_completion(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    console.log(this.bashCompletion());
    cb();
}

do_completion.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_completion.help = [
    'Output bash completion code for the `sdcadm` CLI.',
    '',
    'Installation:',
    '    sdcadm completion >> ~/.bashrc',
    '',
    'Or maybe:',
    '    sdcadm completion > /usr/local/etc/bash_completion.d/sdcadm',
    '',
    'Note that sdcadm experimental, platform and post-setup sub-commands',
    'are not yet included.'
].join('\n');
do_completion.hidden = true;

module.exports = do_completion;
