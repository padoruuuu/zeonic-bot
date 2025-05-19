const { Client, GatewayIntentBits, Partials, WebhookClient } = require('discord.js');// Avatar cache and webhook utilities
async function downloadAvatar(url, userId) {
  try {
    const fetchFn = await getFetch();
    const response = await fetchFn(url);
    const buffer = await response.buffer();
    const filePath = path.join(CACHE_DIR, `${userId}.png`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  } catch (error) {
    console.error('Error downloading avatar:', error?.message || error);
    return null;
  }
}

async function getAvatarUrl(user) {
  // Check if we have a cached avatar
  const cacheFile = path.join(CACHE_DIR, `${user.id}.png`);
  
  try {
    // Check if file exists
    await fs.access(cacheFile);
    return `file://${cacheFile}`;
  } catch (err) {
    // File doesn't exist, download it
    const avatarUrl = user.displayAvatarURL({ extension: 'png', size: 128 });
    
    if (avatarUrl) {
      await downloadAvatar(avatarUrl, user.id);
      return avatarUrl; // Return the original URL for this time
    }
    
    return null;
  }
}

// Get or create webhook for a channel
async function getChannelWebhook(channel) {
  try {
    // Try to find an existing webhook created by the bot
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.owner.id === client.user.id);
    
    // Create a new webhook if none exists
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'LinkEmbedder',
        avatar: client.user.displayAvatarURL(),
        reason: 'Used for seamless link embedding'
      });
    }
    
    return webhook;
  } catch (error) {
    console.error('Webhook error:', error?.message || error);
    return null;
  }
}require('dotenv').config();
const { JSDOM } = require('jsdom');
const { promisify } = require('util');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// Lazily import node-fetch only when needed
let fetch;
const getFetch = async () => {
  if (!fetch) fetch = (await import('node-fetch')).default;
  return fetch;
};

const execAsync = promisify(exec);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Cache directory for user avatars
const CACHE_DIR = path.join(__dirname, 'avatar_cache');

// Ensure cache directory exists
(async () => {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create cache directory:', err.message);
  }
})();

// Minimal client with only required intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message]
});

// Helper functions - Optimized versions
const formatDuration = seconds => {
  if (!seconds) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s]
    .filter((_, i) => i > 0 || h > 0)
    .map(v => v.toString().padStart(2, '0'))
    .join(':');
};

const fetchHtml = async (url, customHeaders = {}) => {
  const fetchFn = await getFetch();
  const response = await fetchFn(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      ...customHeaders
    }
  });
  return await response.text();
};

const extractContent = (doc, selectors) => {
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    if (element) return element.textContent.trim();
  }
  return '';
};

// Simplified image extraction with focus on most important sources
const extractImages = (doc) => {
  const images = new Set();
  
  // Priority sources - metadata
  const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
  const twitterImage = doc.querySelector('meta[name="twitter:image"]')?.content;
  
  if (ogImage) images.add(ogImage);
  if (twitterImage) images.add(twitterImage);
  
  // JSON-LD structured data - simplified processing
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      const data = JSON.parse(script.textContent);
      if (data.image) {
        if (typeof data.image === 'string') {
          images.add(data.image);
        } else if (Array.isArray(data.image)) {
          data.image.slice(0, 5).forEach(img => {
            if (typeof img === 'string') images.add(img);
            else if (img.url) images.add(img.url);
          });
        } else if (data.image.url) {
          images.add(data.image.url);
        }
      }
    } catch (e) {} // Silent error handling
  });
  
  // Optimized selectors - focusing on most commonly used patterns
  const mainImageSelectors = [
    '.post-media img', '.truth-media img', '.media-attachments img', 
    '.status__media img', '.post-image', '.truth-image',
    '.image-attachment', 'article img:not([class*="avatar"]):not([class*="profile"])'
  ];
  
  // Limiting image search to reduce DOM traversal
  let imagesFound = 0;
  for (const selector of mainImageSelectors) {
    if (imagesFound >= 10) break; // Limit image search to save resources
    
    doc.querySelectorAll(selector).forEach(img => {
      if (imagesFound >= 10) return;
      
      if (img.src && 
         !img.src.includes('avatar') && 
         !img.src.includes('profile') &&
         !img.src.includes('icon')) {
        images.add(img.src);
        imagesFound++;
      }
      
      // Check for lazy loading
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc) {
        images.add(dataSrc);
        imagesFound++;
      }
    });
  }
  
  // Background images only if we haven't found enough
  if (imagesFound < 5) {
    doc.querySelectorAll('[style*="background-image"]').forEach(element => {
      if (imagesFound >= 10) return;
      
      const style = element.getAttribute('style');
      if (style) {
        const urlMatch = style.match(/url\(['"]?([^'"]+)['"]?\)/);
        if (urlMatch && urlMatch[1]) {
          images.add(urlMatch[1]);
          imagesFound++;
        }
      }
    });
  }
  
  // Filter out duplicates and non-image URLs
  return [...images].filter(url => 
    url.match(/\.(jpg|jpeg|png|gif|webp)($|\?)/i) || 
    url.includes('/media/') ||
    url.includes('/uploads/')
  );
};

// Create minimal embeds with just essential information
const createEmbed = (platform, url, data) => {
  const embed = {
    color: data.color,
    url: url,
    footer: { text: platform.replace('_', ' ') }
  };

  switch (platform) {
    case 'RUMBLE':
      embed.title = data.title?.slice(0, 256) || 'Untitled';
      embed.thumbnail = data.thumbnail ? { url: data.thumbnail } : undefined;
      
      // Only include essential fields
      embed.fields = [];
      if (data.duration) {
        embed.fields.push({
          name: 'Duration',
          value: formatDuration(data.duration),
          inline: true
        });
      }
      if (data.uploader) {
        embed.fields.push({
          name: 'Uploader',
          value: data.uploader.slice(0, 256),
          inline: true
        });
      }
      break;
      
    case 'TRUTH_SOCIAL':
      embed.author = {
        name: data.author || `@${data.authorUsername}`,
        icon_url: data.profileImage
      };
      
      embed.title = `Truth by @${data.authorUsername}`;
      
      // Truncate description to save memory
      if (data.text) {
        embed.description = data.text.length > 1000 ? 
          data.text.slice(0, 997) + '...' : 
          data.text;
      }
      
      // Add date if available
      if (data.postDate) {
        embed.fields = [{
          name: 'Posted',
          value: data.postDate,
          inline: true
        }];
      }
      
      // Only add first image directly in embed
      if (data.images && data.images.length > 0) {
        embed.image = { url: data.images[0] };
        
        // Add up to 2 additional image links as fields
        if (data.images.length > 1) {
          embed.fields = embed.fields || [];
          for (let i = 1; i < Math.min(data.images.length, 3); i++) {
            embed.fields.push({
              name: `Image ${i+1}`,
              value: `[View](${data.images[i]})`,
              inline: true
            });
          }
        }
      }
      break;
  }
  
  return embed;
};

// Platform handlers - optimized for minimal processing
const PLATFORMS = {
  RUMBLE: {
    regex: /(https?:\/\/(?:www\.)?rumble\.com\/(?:embed\/)?v[\w-]+[^ \n]*)/i,
    embed: async (url) => {
      try {
        // Using yt-dlp with minimal output format
        const { stdout } = await execAsync(
          `yt-dlp -j --no-playlist --no-warnings "${url}"`
        );
        const data = JSON.parse(stdout);
        return {
          title: data.title,
          thumbnail: data.thumbnail,
          duration: data.duration,
          uploader: data.uploader,
          color: 0xFFA500
        };
      } catch (error) {
        console.error('Rumble error:', error?.message || error);
        return null;
      }
    }
  },
  
  TRUTH_SOCIAL: {
    regex: /(https?:\/\/(?:www\.)?truthsocial\.com\/@[\w.]+\/posts\/\d+[^ \n]*)/i,
    embed: async (url) => {
      try {
        const html = await fetchHtml(url, { 'Referer': 'https://truthsocial.com/' });
        const dom = new JSDOM(html, { runScripts: "outside-only" }); // Less resource intensive
        const doc = dom.window.document;
        
        // Extract username from URL to avoid regex operations
        const urlParts = url.split('/');
        const usernameWithAt = urlParts[urlParts.indexOf('truthsocial.com') + 1] || '';
        const username = usernameWithAt.startsWith('@') ? usernameWithAt.slice(1) : usernameWithAt;
        
        // Priority content selectors - checking most likely selectors first
        const contentSelectors = [
          '.post-content', '.truth-content', '.status__content', 
          'article .content', '.truth-body'
        ];
        
        let postContent = extractContent(doc, contentSelectors);
        
        // Fallback to OpenGraph description
        if (!postContent) {
          postContent = doc.querySelector('meta[property="og:description"]')?.content || '';
        }
        
        // Simplified timestamp extraction
        const timeSelectors = ['.post-date', '.truth-date', 'time', '.status__time'];
        let timestamp = extractContent(doc, timeSelectors);
        
        if (!timestamp) {
          timestamp = doc.querySelector('meta[property="article:published_time"]')?.content || '';
        }
        
        // Simple date formatting
        let formattedDate = '';
        if (timestamp) {
          try {
            formattedDate = new Date(timestamp).toLocaleDateString();
          } catch (e) {
            formattedDate = timestamp;
          }
        }
        
        // Extract images with limit to reduce processing
        const images = extractImages(doc);
        
        // Get author details - simplified
        const authorDisplayName = extractContent(doc, ['.post-author', '.truth-author', '.author-name']) || username;
        
        // Simplified profile image extraction
        let profileImage = null;
        const avatars = doc.querySelectorAll('.avatar img, .profile-image img');
        if (avatars.length > 0) profileImage = avatars[0].src;
        
        return {
          text: postContent,
          images: images,
          author: authorDisplayName,
          authorUsername: username,
          profileImage: profileImage,
          postDate: formattedDate,
          color: 0xFF4500
        };
      } catch (error) {
        console.error('Truth Social error:', error?.message || error);
        return { 
          text: 'Could not fetch post content.',
          authorUsername: 'unknown',
          color: 0xFF4500
        };
      }
    }
  }
};

// Optimized message processor
const processMessage = async (message) => {
  if (message.author.bot) return;

  // Check message content directly without unnecessary regex operations
  const content = message.content;
  
  // Quickly check if there's likely a URL to process
  if (!content.includes('http')) return;
  
  // Try each platform
  for (const [platform, config] of Object.entries(PLATFORMS)) {
    const match = content.match(config.regex);
    if (!match) continue;
    
    const matchedUrl = match[0];
    console.log(`Processing ${platform} URL: ${matchedUrl}`);
    
    try {
      // Get platform data
      const platformData = await config.embed(matchedUrl);
      if (!platformData) continue;

      // Get clean content without the URL
      const cleanContent = content.replace(matchedUrl, '').trim();
      
      // Create embed
      const embed = createEmbed(platform, matchedUrl, platformData);
      
      // Get or create a webhook for this channel
      const webhook = await getChannelWebhook(message.channel);
      
      if (webhook) {
        // Cache user avatar if not already cached
        await getAvatarUrl(message.author);
        
        // Use webhook to post as the original user
        await webhook.send({
          content: cleanContent ? `${cleanContent}\n${matchedUrl}` : matchedUrl,
          username: message.member?.nickname || message.author.username,
          avatarURL: message.author.displayAvatarURL(),
          embeds: [embed]
        });
        
        // Delete original message
        if (message.deletable) {
          await message.delete().catch(e => {
            console.error('Failed to delete message:', e?.message || e);
          });
        }
        
        // For posts with multiple images, send additional images with the same webhook
        if (platform === 'TRUTH_SOCIAL' && platformData.images && platformData.images.length > 1) {
          // Send at most 2 more images to save bandwidth
          const additionalImages = platformData.images.slice(1, 3);
          if (additionalImages.length > 0) {
            const additionalEmbeds = additionalImages.map(imageUrl => ({
              color: platformData.color,
              image: { url: imageUrl }
            }));
            
            await webhook.send({
              username: message.member?.nickname || message.author.username,
              avatarURL: message.author.displayAvatarURL(),
              embeds: additionalEmbeds
            }).catch(e => {
              console.error('Failed to send additional images:', e?.message || e);
            });
          }
        }
      } else {
        // Fallback to regular message if webhook creation failed
        const response = await message.channel.send({
          content: cleanContent ? `${cleanContent}\n${matchedUrl}` : matchedUrl,
          embeds: [embed]
        });
        
        // Try to delete original message
        if (message.deletable) {
          await message.delete().catch(console.error);
        }
      }
      
      return; // Stop after processing the first matched platform
    } catch (error) {
      console.error('Error processing URL:', error?.message || error);
      await message.channel.send({
        content: `⚠️ Error processing link: ${matchedUrl}`
      }).catch(console.error);
      return;
    }
  }
};

// Event handlers
client.once('ready', () => {
  console.log(`Bot running as ${client.user.tag}`);
  
  // Create cache directory at startup
  fs.mkdir(CACHE_DIR, { recursive: true }).catch(error => {
    console.error('Failed to create cache directory:', error?.message || error);
  });
});

client.on('messageCreate', processMessage);

// Clean up old avatar cache files periodically (every 24 hours)
setInterval(async () => {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = await fs.stat(filePath);
      
      // If file is older than 7 days, delete it
      if (now - stats.mtime.getTime() > 7 * 24 * 60 * 60 * 1000) {
        await fs.unlink(filePath).catch(console.error);
      }
    }
  } catch (error) {
    console.error('Cache cleanup error:', error?.message || error);
  }
}, 24 * 60 * 60 * 1000);

// Error handling
client.on('error', error => {
  console.error('Discord client error:', error?.message || error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error?.message || error);
});

// Memory management - Every hour
setInterval(() => {
  global.gc && global.gc(); // Force garbage collection if available
  console.log(`Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
}, 3600000);

// Start the bot
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('Failed to login:', e?.message || e);
});