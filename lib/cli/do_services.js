/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 *
 * `sdcadm services ...` shortcut for `sdcadm service list ...`.
 */

var targ = require('./do_service/do_list');

function do_services(subcmd, opts, args, callback) {
    this.handlerFromSubcmd('service').dispatch({
        subcmd: 'list',
        opts: opts,
        args: args
    }, callback);
}

do_services.help = 'A shortcut for "sdcadm service list".\n' + targ.help;
do_services.synopses = targ.synopses;
do_services.options = targ.options;
do_services.completionArgtypes = targ.completionArgtypes;

do_services.aliases = ['svcs'];

module.exports = do_services;
