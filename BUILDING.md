# The Code, getting it.

We use git submodules because I want to use "wmsy", the widgeting library I
wrote, for the UI and it is more than a single file.  So, you will want
to do:

    git submodule update --init --recursive

This will also pull whatever version of the Jetpack/Mozilla add-on SDK we are
using.


# Running / Installing / Building

This is a Jetpack/Mozilla add-on SDK extension, so you need to be sure to
source "bin/activate" from the addon-sdk/ subdir before trying to run us.
But once you have, rather than using "cfx", you want to use "./acfx".  You
want to do this because we need to rsync some files into the data/ directory
in order for anything to work.

This is necessitated by our libraries and use of git submodules.  We want to
only include the JS files from the submodule in our XPI and we also want them
at a very precise location.

To make the build/develop cycle slightly easier (maybe) we have revision
controlled the UI files in the data/ subtree directly so that we can just
refresh the UI without restarting the jetpack extension.  To make things
(somewhat) less confusing, everything we rsync into data will be under
data/deps/.
