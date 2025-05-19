require('dotenv').config();
const { Client, GatewayIntentBits, WebhookClient } = require('discord.js');
const { JSDOM } = require('jsdom');
const { promisify } = require('util');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// Lazily import node-fetch
let fetch;
const getFetch = async () => {
  if (!fetch) fetch = (await import('node-fetch')).default;
  return fetch;
};

const execAsync = promisify(exec);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const CACHE_DIR = path.join(__dirname, 'avatar_cache');

// Create cache directory
(async () => {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create cache directory:', err.message);
  }
})();

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Helper functions
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

const extractImages = (doc) => {
  const images = new Set();
  
  // Metadata images
  const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
  const twitterImage = doc.querySelector('meta[name="twitter:image"]')?.content;
  
  if (ogImage) images.add(ogImage);
  if (twitterImage) images.add(twitterImage);
  
  // JSON-LD structured data
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
    } catch (e) {} // Ignore parse errors
  });
  
  // Main image selectors
  const mainImageSelectors = [
    '.post-media img', '.truth-media img', '.status__media img', 
    'article img:not([class*="avatar"]):not([class*="profile"])'
  ];
  
  // Get images from selectors
  let imagesFound = 0;
  for (const selector of mainImageSelectors) {
    if (imagesFound >= 10) break;
    
    doc.querySelectorAll(selector).forEach(img => {
      if (imagesFound >= 10) return;
      
      if (img.src && !img.src.includes('avatar') && !img.src.includes('profile')) {
        images.add(img.src);
        imagesFound++;
      }
      
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc) {
        images.add(dataSrc);
        imagesFound++;
      }
    });
  }
  
  // Filter and return images
  return [...images].filter(url => 
    url.match(/\.(jpg|jpeg|png|gif|webp)($|\?)/i) || 
    url.includes('/media/') ||
    url.includes('/uploads/')
  );
};

// Avatar and webhook utilities
async function getOrCreateWebhook(channel) {
  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.owner.id === client.user.id);
    
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'LinkEmbedder',
        avatar: client.user.displayAvatarURL(),
        reason: 'Used for link embedding'
      });
    }
    
    return webhook;
  } catch (error) {
    console.error('Webhook error:', error?.message || error);
    return null;
  }
}

async function getAvatar(user) {
  const cacheFile = path.join(CACHE_DIR, `${user.id}.png`);
  
  try {
    await fs.access(cacheFile);
    return user.displayAvatarURL();
  } catch (err) {
    try {
      const fetchFn = await getFetch();
      const response = await fetchFn(user.displayAvatarURL({ extension: 'png', size: 128 }));
      const buffer = await response.buffer();
      await fs.writeFile(cacheFile, buffer);
    } catch (error) {
      console.error('Avatar error:', error?.message || error);
    }
    return user.displayAvatarURL();
  }
}

// Platform handlers
const PLATFORMS = {
  RUMBLE: {
    regex: /(https?:\/\/(?:www\.)?rumble\.com\/(?:embed\/)?v[\w-]+[^ \n]*)/i,
    embed: async (url) => {
      try {
        const { stdout } = await execAsync(`yt-dlp -j --no-playlist --no-warnings "${url}"`);
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
    },
    createEmbed: (url, data) => ({
      color: data.color,
      url: url,
      title: data.title?.slice(0, 256) || 'Untitled',
      thumbnail: data.thumbnail ? { url: data.thumbnail } : undefined,
      fields: [
        data.duration ? {
          name: 'Duration',
          value: formatDuration(data.duration),
          inline: true
        } : null,
        data.uploader ? {
          name: 'Uploader',
          value: data.uploader.slice(0, 256),
          inline: true
        } : null
      ].filter(Boolean),
      footer: { text: 'Rumble' }
    })
  },
  
  TRUTH_SOCIAL: {
    regex: /(https?:\/\/(?:www\.)?truthsocial\.com\/@[\w.]+\/posts\/\d+[^ \n]*)/i,
    embed: async (url) => {
      try {
        const html = await fetchHtml(url, { 'Referer': 'https://truthsocial.com/' });
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        
        // Extract username from URL
        const urlParts = url.split('/');
        const usernameWithAt = urlParts[urlParts.indexOf('truthsocial.com') + 1] || '';
        const username = usernameWithAt.startsWith('@') ? usernameWithAt.slice(1) : usernameWithAt;
        
        // Get content
        const contentSelectors = ['.post-content', '.truth-content', '.status__content', 'article .content'];
        let postContent = extractContent(doc, contentSelectors);
        if (!postContent) {
          postContent = doc.querySelector('meta[property="og:description"]')?.content || '';
        }
        
        // Get timestamp
        const timeSelectors = ['.post-date', '.truth-date', 'time'];
        let timestamp = extractContent(doc, timeSelectors);
        if (!timestamp) {
          timestamp = doc.querySelector('meta[property="article:published_time"]')?.content || '';
        }
        
        // Format date
        let formattedDate = '';
        if (timestamp) {
          try {
            formattedDate = new Date(timestamp).toLocaleDateString();
          } catch (e) {
            formattedDate = timestamp;
          }
        }
        
        // Get images
        const images = extractImages(doc);
        
        // Get author details
        const authorDisplayName = extractContent(doc, ['.post-author', '.truth-author', '.author-name']) || username;
        
        // Get profile image
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
    },
    createEmbed: (url, data) => ({
      color: data.color,
      url: url,
      author: {
        name: data.author || `@${data.authorUsername}`,
        icon_url: data.profileImage
      },
      title: `Truth by @${data.authorUsername}`,
      description: data.text?.length > 1000 ? data.text.slice(0, 997) + '...' : data.text,
      fields: [
        data.postDate ? {
          name: 'Posted',
          value: data.postDate,
          inline: true
        } : null
      ].filter(Boolean),
      image: data.images?.length > 0 ? { url: data.images[0] } : undefined,
      footer: { text: 'Truth Social' }
    })
  }
};

// Process Discord messages
const processMessage = async (message) => {
  if (message.author.bot) return;
  
  const content = message.content;
  if (!content.includes('http')) return;
  
  for (const [platform, config] of Object.entries(PLATFORMS)) {
    const match = content.match(config.regex);
    if (!match) continue;
    
    const matchedUrl = match[0];
    console.log(`Processing ${platform} URL: ${matchedUrl}`);
    
    try {
      // Get data for this platform
      const platformData = await config.embed(matchedUrl);
      if (!platformData) continue;

      // Get clean content
      const cleanContent = content.replace(matchedUrl, '').trim();
      
      // Create embed
      const embed = config.createEmbed(matchedUrl, platformData);
      
      // Get webhook
      const webhook = await getOrCreateWebhook(message.channel);
      
      if (webhook) {
        // Cache avatar
        await getAvatar(message.author);
        
        // Send main message
        await webhook.send({
          content: cleanContent ? `${cleanContent}\n${matchedUrl}` : matchedUrl,
          username: message.member?.nickname || message.author.username,
          avatarURL: message.author.displayAvatarURL(),
          embeds: [embed]
        });
        
        // Delete original
        if (message.deletable) {
          await message.delete().catch(console.error);
        }
        
        // Send additional images for Truth Social
        if (platform === 'TRUTH_SOCIAL' && platformData.images && platformData.images.length > 1) {
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
            }).catch(console.error);
          }
        }
      } else {
        // Fallback to regular message
        await message.channel.send({
          content: cleanContent ? `${cleanContent}\n${matchedUrl}` : matchedUrl,
          embeds: [embed]
        });
        
        if (message.deletable) {
          await message.delete().catch(console.error);
        }
      }
      
      return; // Stop after processing the first match
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
});

client.on('messageCreate', processMessage);

// Clean avatar cache daily
setInterval(async () => {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = await fs.stat(filePath);
      
      // Delete if older than 7 days
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

// Log memory usage hourly
setInterval(() => {
  global.gc && global.gc(); // Optional garbage collection
  console.log(`Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
}, 3600000);

// Start the bot
client.login(process.env.DISCORD_TOKEN).catch(console.error);
