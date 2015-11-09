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
 * The 'sdcadm experimental update-gz-tools' CLI subcommand.
 */

/**
 * This is the temporary quick replacement for incr-upgrade's
 * "upgrade-tools.sh".
 */

function do_update_gz_tools(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var execStart = Date.now();

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    function finish(err) {
        if (err) {
            return cb(err);
        }
        progress('Updated gz-tools successfully (elapsed %ds).',
            Math.floor((Date.now() - execStart) / 1000));
        return cb();
    }

    if (!opts.latest && !args[0]) {
        return finish(new errors.UsageError(
            'must specify installer image UUID or --latest'));
    }

    self.sdcadm.updateGzTools({
        image: opts.latest ? 'latest' : args[0],
        progress: progress,
        justDownload: opts.just_download,
        forceReinstall: opts.force_reinstall
    }, finish);

}
do_update_gz_tools.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published gz-tools installer.'
    },
    {
        names: ['force-reinstall'],
        type: 'bool',
        help: 'Force reinstall of the current gz-tools image in use.'
    },
    {
        names: ['just-download'],
        type: 'bool',
        help: 'Download the GZ Tools installer for later usage.'
    }
];
do_update_gz_tools.help = (
    'Temporary grabbag for updating the SDC global zone tools.\n' +
    'The eventual goal is to integrate all of this into "sdcadm update".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-gz-tools IMAGE-UUID\n' +
    '     {{name}} update-gz-tools PATH-TO-INSTALLER\n' +
    '     {{name}} update-gz-tools --latest\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_update_gz_tools: do_update_gz_tools
};
