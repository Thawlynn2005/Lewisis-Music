//! Covers and playlist photos: any picture becomes a JPEG (or a PNG when it has
//! see-through parts), turned the right way up, no larger than [`COVER_SIDE`],
//! and without its hidden details (camera, location and so on).

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageReader, imageops::FilterType};

use crate::{Error, Result};

/// Covers are stored no larger than this many pixels on their longest side.
pub const COVER_SIDE: u32 = 1400;
/// The largest picture file accepted.
pub const MAX_BYTES: usize = 40 * 1024 * 1024;

/// A picture ready to be saved: its bytes and file extension (".jpg" / ".png").
pub struct Picture {
    pub bytes: Vec<u8>,
    pub extension: &'static str,
}

impl Picture {
    pub fn mime(&self) -> &'static str {
        if self.extension == ".png" { "image/png" } else { "image/jpeg" }
    }
}

fn unreadable() -> Error {
    Error::invalid("That file is not a picture Lewisis' Music can open.")
}

/// Decode, straighten, shrink and re-encode a picture.
pub fn normalise(data: &[u8]) -> Result<Picture> {
    if data.len() > MAX_BYTES {
        return Err(Error::invalid("That picture is too large (the limit is 40 MB)."));
    }
    let reader = ImageReader::new(Cursor::new(data)).with_guessed_format().map_err(|_| unreadable())?;
    let mut decoder = reader.into_decoder().map_err(|_| unreadable())?;
    let orientation = decoder.orientation().ok();
    let mut picture = DynamicImage::from_decoder(decoder).map_err(|_| unreadable())?;
    if let Some(orientation) = orientation {
        picture.apply_orientation(orientation);
    }
    if picture.width() > COVER_SIDE || picture.height() > COVER_SIDE {
        picture = picture.resize(COVER_SIDE, COVER_SIDE, FilterType::Lanczos3);
    }

    let see_through = picture.color().has_alpha() && picture.to_rgba8().pixels().any(|p| p.0[3] < 255);
    let mut bytes = Vec::new();
    if see_through {
        picture
            .to_rgba8()
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .map_err(|_| unreadable())?;
        Ok(Picture { bytes, extension: ".png" })
    } else {
        JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode_image(&picture.to_rgb8())
            .map_err(|_| unreadable())?;
        Ok(Picture { bytes, extension: ".jpg" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn encode(image: DynamicImage, format: image::ImageFormat) -> Vec<u8> {
        let mut bytes = Vec::new();
        image.write_to(&mut Cursor::new(&mut bytes), format).unwrap();
        bytes
    }

    #[test]
    fn big_photos_shrink_to_a_jpeg() {
        let photo = DynamicImage::ImageRgb8(RgbImage::from_pixel(3000, 2000, Rgb([40, 90, 220])));
        let picture = normalise(&encode(photo, image::ImageFormat::Png)).unwrap();
        assert_eq!(picture.extension, ".jpg");
        let back = image::load_from_memory(&picture.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (1400, 933));
    }

    #[test]
    fn see_through_pictures_stay_png() {
        let mut logo = RgbaImage::from_pixel(100, 100, Rgba([0, 0, 0, 0]));
        logo.put_pixel(50, 50, Rgba([220, 20, 60, 255]));
        let picture = normalise(&encode(DynamicImage::ImageRgba8(logo), image::ImageFormat::Png)).unwrap();
        assert_eq!(picture.extension, ".png");
    }

    #[test]
    fn rejects_non_pictures() {
        assert!(normalise(b"definitely not a picture").is_err());
    }
}
