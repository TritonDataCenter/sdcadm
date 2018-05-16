/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 *
 * `sdcadm completion`
 */

function do_completion(subcmd, opts, _args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    console.log(this.bashCompletion({includeHidden: true}));
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
    'By default, sdcadm installation should setup for Bash completion.',
    'However, you can update the completions as follows:',
    '',
    '    sdcadm completion >/opt/smartdc/sdcadm/etc/sdcadm.completion \\',
    '       && source /opt/smartdc/sdcadm/etc/sdcadm.completion'
].join('\n');
do_completion.hidden = true;

module.exports = do_completion;
