/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

var steps = require('../steps');

/*
 * The 'sdcadm experimental add-new-agent-svcs' CLI subcommand.
 */
function do_add_new_agent_svcs(_subcmd, _opts, _args, cb) {
    console.error(
        'Warning: "sdcadm experimental add-new-agent-svcs" is deprecated.');
    console.error('Use "sdcadm experimental update-other" or');
    console.error('"sdcadm experimental update-agents".\n');
    steps.sapi.ensureAgentServices({
        progress: this.progress,
        sdcadm: this.sdcadm,
        log: this.log
    }, cb);
}

do_add_new_agent_svcs.options = [ {
    names: ['help', 'h'],
    type: 'bool',
    help: 'Show this help.'
}];

do_add_new_agent_svcs.help = [
    'DEPRECATED. Ensure a SAPI service exists for each core Triton agent.',
    '',
    'This is deprecated, both "sdcadm experimental update-agents" and',
    '"sdcadm experimental update-other" now provide this functionality.',
    '',
    'Usage:',
    '     {{name}} add-new-agent-svcs\n',
    '',
    '{{options}}'
].join('\n');
do_add_new_agent_svcs.hidden = true;


// --- exports

module.exports = {
    do_add_new_agent_svcs: do_add_new_agent_svcs
};
