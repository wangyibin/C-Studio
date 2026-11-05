//! Cross-module regression: real Cooler I/O, reviewed AGP layouts, projection and cache reuse.
use std::{
    path::PathBuf,
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

use cstudio_core::{
    agp::{AgpSummary, Orientation},
    contact_cache::{ContactCache, ContactCacheKey},
    contact_map::{
        build_contact_map_view, ContactBin, ContactMapCell, ContactMapQuery, LayoutBlock, Viewport,
    },
    cool::{list_contact_resolutions, read_cool_contacts_for_sources},
};
use hdf5::{
    types::{FixedAscii, VarLenUnicode},
    File,
};

const INPUT: &str = include_str!("../../../tests/fixtures/curation/input.agp");
const EDITED: &str = include_str!("../../../tests/fixtures/curation/edited.agp");
const CONTACTS: &str = include_str!("../../../tests/fixtures/curation/contacts.tsv");
const EXPECTED: &str = include_str!("../../../tests/fixtures/curation/expected-contact-cells.tsv");
const SOURCES: [&str; 4] = ["ctgA", "ctgB", "ctgC", "ctgD"];

struct TinyCool(PathBuf);

impl TinyCool {
    fn create() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cstudio-workflow-{}-{nonce}.cool",
            std::process::id()
        ));
        let fixture = Self(path);
        let file = File::create(&fixture.0).unwrap();
        // Required Cooler schema v3 metadata, including the real fixed-bin path.
        for (name, value) in [
            ("format", "HDF5::Cooler"),
            ("bin-type", "fixed"),
            ("storage-mode", "symmetric-upper"),
        ] {
            file.new_attr::<VarLenUnicode>()
                .shape(())
                .create(name)
                .unwrap()
                .write_scalar(&VarLenUnicode::from_str(value).unwrap())
                .unwrap();
        }
        for (name, value) in [("format-version", 3_i64), ("bin-size", 1000)] {
            file.new_attr::<i64>()
                .shape(())
                .create(name)
                .unwrap()
                .write_scalar(&value)
                .unwrap();
        }
        for group in ["chroms", "bins", "pixels", "indexes"] {
            file.create_group(group).unwrap();
        }
        let names: Vec<_> = SOURCES
            .iter()
            .map(|name| FixedAscii::<4>::from_ascii(name).unwrap())
            .collect();
        file.new_dataset_builder()
            .with_data(&names)
            .create("chroms/name")
            .unwrap();
        write(&file, "chroms/length", &[4000_i64; 4]);
        write(
            &file,
            "bins/chrom",
            &(0..4_i32).flat_map(|chrom| [chrom; 4]).collect::<Vec<_>>(),
        );
        write(
            &file,
            "bins/start",
            &(0..16_i64).map(|bin| bin % 4 * 1000).collect::<Vec<_>>(),
        );
        write(
            &file,
            "bins/end",
            &(0..16_i64)
                .map(|bin| (bin % 4 + 1) * 1000)
                .collect::<Vec<_>>(),
        );
        let contacts = fixture_contacts();
        let bin = |source: &str, start| {
            SOURCES.iter().position(|name| *name == source).unwrap() as u64 * 4 + start / 1000
        };
        let bin1: Vec<i64> = contacts
            .iter()
            .map(|c| bin(&c.source1, c.start1) as i64)
            .collect();
        let bin2: Vec<i64> = contacts
            .iter()
            .map(|c| bin(&c.source2, c.start2) as i64)
            .collect();
        let counts: Vec<f64> = contacts.iter().map(|c| c.count).collect();
        assert!(bin1.windows(2).all(|pair| pair[0] <= pair[1]));
        write(&file, "pixels/bin1_id", &bin1);
        write(&file, "pixels/bin2_id", &bin2);
        write(&file, "pixels/count", &counts);
        let offsets: Vec<i64> = (0..=16)
            .map(|bin| bin1.iter().filter(|id| **id < bin).count() as i64)
            .collect();
        write(&file, "indexes/bin1_offset", &offsets);
        write(&file, "indexes/chrom_offset", &[0_i64, 4, 8, 12, 16]);
        file.flush().unwrap();
        fixture
    }

    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for TinyCool {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write<T: hdf5::H5Type>(file: &File, name: &str, values: &[T]) {
    file.new_dataset_builder()
        .with_data(values)
        .create(name)
        .unwrap();
}

fn fixture_contacts() -> Vec<ContactBin> {
    CONTACTS
        .lines()
        .skip(1)
        .map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            ContactBin {
                source1: fields[0].into(),
                start1: fields[1].parse().unwrap(),
                source2: fields[2].into(),
                start2: fields[3].parse().unwrap(),
                count: fields[4].parse().unwrap(),
            }
        })
        .collect()
}

// Test-only adapter for the shared AGP oracle. The frontend workflow verifies
// the production AGP importer/exporter against the same literal files.
fn query_from_agp(text: &str, target_resolution: u64) -> ContactMapQuery {
    AgpSummary::parse(text).unwrap();
    let mut object = "";
    let mut object_offset = 0;
    let mut object_end = 0;
    let mut blocks = Vec::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        if object != fields[0] {
            object_offset += object_end;
            object_end = 0;
            object = fields[0];
        }
        let end = fields[2].parse::<u64>().unwrap();
        object_end = object_end.max(end);
        if matches!(fields[4], "N" | "U") {
            continue;
        }
        blocks.push(LayoutBlock {
            id: format!("{}:{}:{}", fields[0], fields[3], fields[5]),
            source_id: fields[5].into(),
            source_start: fields[6].parse::<u64>().unwrap() - 1,
            source_end: fields[7].parse().unwrap(),
            visual_start: object_offset + fields[1].parse::<u64>().unwrap() - 1,
            orientation: match fields[8] {
                "+" => Orientation::Forward,
                "-" => Orientation::Reverse,
                other => panic!("unexpected fixture orientation: {other}"),
            },
        });
    }
    let span = object_offset + object_end;
    ContactMapQuery {
        base_resolution: 1000,
        target_resolution,
        viewport: Viewport {
            x_start: 0,
            x_end: span,
            y_start: 0,
            y_end: span,
        },
        layout_blocks: blocks,
    }
}

fn expected_cells(assembly: &str, resolution: u64) -> Vec<ContactMapCell> {
    EXPECTED
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            (fields[0] == assembly && fields[1].parse::<u64>().unwrap() == resolution).then(|| {
                ContactMapCell {
                    x_bin: fields[2].parse().unwrap(),
                    y_bin: fields[3].parse().unwrap(),
                    count: fields[4].parse().unwrap(),
                }
            })
        })
        .collect()
}

#[test]
fn cooler_contacts_follow_curated_layouts_at_two_resolutions_with_and_without_cache() {
    let file = TinyCool::create();
    let source_ids: Vec<_> = SOURCES.iter().map(|source| source.to_string()).collect();
    assert_eq!(list_contact_resolutions(file.path()).unwrap(), vec![1000]);
    let contacts = read_cool_contacts_for_sources(file.path(), &source_ids).unwrap();
    assert_eq!(contacts, fixture_contacts());
    let key = ContactCacheKey {
        path: file.path().into(),
        resolution: 1000,
        source_ids,
    };
    let mut cache = ContactCache::new();
    // One disk read seeds the cache; every subsequent edit/resolution change
    // must reproject those same observations, without reading new contacts.
    let initial = query_from_agp(INPUT, 1000);
    cache
        .build_view(key.clone(), &initial, |_| Ok(contacts.clone()))
        .unwrap();
    for (name, agp, resolution) in [
        ("input", INPUT, 1000),
        ("edited", EDITED, 1000),
        ("edited", EDITED, 2000),
    ] {
        let query = query_from_agp(agp, resolution);
        let expected = expected_cells(name, resolution);
        assert_eq!(
            expected.len(),
            5,
            "each oracle must contain five independently calculated cells"
        );
        let uncached = build_contact_map_view(&query, contacts.clone()).unwrap();
        assert_eq!(uncached.cells, expected, "{name} at {resolution} bp");
        assert_eq!(
            uncached.cells.iter().map(|cell| cell.count).sum::<f64>(),
            28.0
        );
        let cached = cache
            .build_view(key.clone(), &query, |_| {
                panic!("curation must reuse the source contacts")
            })
            .unwrap();
        assert_eq!(cached, uncached);
    }
    assert_eq!(cache.entry_count(), 1);
}
