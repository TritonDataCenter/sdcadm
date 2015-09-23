A "step" is a JS function with the signature:

        function (arg, next)

It is meant to be encapsulate a useful chunk of a work (a step) done
for some sdcadm process, e.g. a small thing like "run imgadm import of the
given UUID locally", or a larger thing like "wait for the given instance (a VM)
to come online". Typically the "sdcadm process" here is a part of `sdcadm up`
or `sdcadm post-setup ...`. 


# Goals

- Separate smaller files for easier maintenance.
- Easier discovery so there is more re-use of these steps. 
- Some attempt at standardization of the steps' args and handling. 

The hope is that this leads to tighter and more self-explanatory
`vasync.pipeline`s in other sdcadm code.


# Code organization

You can have one step (a function) per .js file... or if there are a few
related steps, then group them in a common js file. Let's have each
exported step *re-exported* from "lib/steps/index.js", then typical
usage can be:

    var steps = require('./steps');

    // ...
    vasync.pipeline({arg: contextArg, funcs: [
        steps.doACommonThing,
        steps.doAnotherCommonThing,
        function aStepSpecificToHere(arg, next) {
            // ...
        },
        steps.finishWithThisCommonThing
    ]}, function (err) {
        // ...
    });


# TODO

- At the time of writing "lib/procedures/shared.js" has a lot of
  functions with the same idea. I propose moving those to "lib/steps/\*.js"
  over time.
- I expect that we'll want curried versions of some of these steps. E.g.:

        vasync.pipeline({arg: contextArg, funcs: [
            // ...
            steps.waitForInstToBeUp('imgapiInst'),
            // ...

  where `'imgapiInst'` is the name of variable on the context `arg` with the
  instance details. Feel that out.
