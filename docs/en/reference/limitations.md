# Current limitations

C-Studio is under active development. Keep these boundaries in mind:

- Desktop packages target Apple Silicon macOS and Windows x86-64. macOS packages
  are not notarized, Windows packages are unsigned, and there is no Linux
  desktop release.
- **Load example project** requires a source checkout; packaged applications
  should load example files individually.
- C-Studio exports edited AGP files and their optional history sidecars, but
  does not currently export FASTA.
- The edited AGP is authoritative. Contact maps, PAF, coverage, and GFA assist
  review, but every edit requires user confirmation and still needs independent
  biological validation.
