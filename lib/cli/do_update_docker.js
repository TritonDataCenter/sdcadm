/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 *
 * sdcadm experimental update-docker
 *
 * This was DEPRECATED, ... well eviscerated, in TOOLS-1438 and replaced
 * with 'sdcadm post-setup docker'. This will now warn and then run the
 * new command.
 */

function do_update_docker(subcmd, opts, _args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    console.error(
        '* * *\n'
        + '"sdcadm experimental update-docker ..." has been replaced by\n'
        + '"sdcadm post-setup docker". Running the new command now.\n'
        + 'Please update your scripts.\n'
        + '* * *\n');

    var argv = ['', '', 'docker'];
    if (opts.force) {
        argv.push('-f');
    }
    this.top.handlerFromSubcmd('post-setup').main(argv, cb);
}

do_update_docker.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Allow update to proceed even if already at latest image.'
    },
    {
        names: ['servers'],
        helpArg: 'SERVERS',
        type: 'arrayOfString',
        help: 'Ignored. Here for backward compatiblity.'
    }
];
do_update_docker.help =
        'This command has been replaced by `sdcadm post-setup docker`.';

module.exports = {
    do_update_docker: do_update_docker
};
