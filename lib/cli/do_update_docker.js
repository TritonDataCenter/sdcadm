/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var util = require('util'),
    format = util.format;

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var steps = require('../steps');
/*
 * The 'sdcadm experimental update-docker' CLI subcommand.
 * DEPRECATED!!!
 */
function do_update_docker(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }
    return cb(new errors.UsageError('Deprecated. Use `sdcadm post-setup '
        + 'docker` and `sdcadm update docker` instead.'));
}

do_update_docker.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_update_docker.help = (
    'Deprecated. Use `sdcadm post-setup docker` ' +
    'and `sdcadm update docker` instead.'
);

// --- exports

module.exports = {
    do_update_docker: do_update_docker
};
